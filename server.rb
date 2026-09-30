require "csv"
require "fileutils"
require "json"
require "openssl"
require "pg"
require "securerandom"
require "uri"
require "webrick"

ROOT = File.expand_path(__dir__)
CSV_PATH = File.join(ROOT, "jura-trip.csv")
STORE_PATH = File.join(ROOT, ".jura-shared.json")
PORT = Integer(ENV.fetch("PORT", "8000"))
MEMBERS = ["Kai", "Giulio", "Lucia", "Felix"].freeze
DB_LOCK = Mutex.new
DB = PG.connect(ENV.fetch("DATABASE_URL"))
SESSION_LOCK = Mutex.new
SESSIONS = {}

def load_dotenv
  path = File.join(ROOT, ".env")
  return unless File.file?(path)

  File.foreach(path) do |line|
    key, value = line.strip.split("=", 2)
    next if key.nil? || key.empty? || key.start_with?("#") || ENV.key?(key)

    ENV[key] = value.to_s.sub(/\A['"]/, "").sub(/['"]\z/, "")
  end
end

def seeded_activities
  return [] unless File.file?(CSV_PATH)

  CSV.read(CSV_PATH, headers: true).map do |row|
    next unless row["type"] == "activity"

    {
      "id" => row["id"],
      "date" => row["date"],
      "time" => row["time"].to_s,
      "title" => row["title"],
      "location" => row["location"],
      "details" => row["details"],
      "url" => row["url"].to_s,
      "status" => row["status"] == "done" ? "done" : "pending",
      "created_by" => "Felix",
      "likes" => []
    }
  end.compact
end

def seeded_entries
  return [] unless File.file?(CSV_PATH)

  CSV.read(CSV_PATH, headers: true).map do |row|
    next unless %w[expense settlement].include?(row["type"])

    entry = row.to_h
    entry["split"] = "4" if entry["type"] == "expense" && entry["split"].to_s.empty?
    entry
  end.compact
end

def seeded_stay
  return {} unless File.file?(CSV_PATH)

  row = CSV.read(CSV_PATH, headers: true).find { |entry| entry["type"] == "stay" }
  return {} unless row

  row.to_h.merge("created_by" => "Felix")
end

def default_store
  {
    "activities" => seeded_activities,
    "entries" => seeded_entries,
    "stay" => seeded_stay,
    "member_ibans" => {}
  }
end

def normalize_store(data)
  data["activities"] ||= seeded_activities
  data["entries"] ||= seeded_entries
  data["stay"] ||= seeded_stay
  data["member_ibans"] ||= {}
  data
end

def create_database_table
  DB.exec <<~SQL
    CREATE TABLE IF NOT EXISTS jura_store (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL
    )
  SQL
end

def initial_store
  if File.file?(STORE_PATH)
    begin
      normalize_store(JSON.parse(File.read(STORE_PATH)))
    rescue JSON::ParserError
      default_store
    end
  else
    default_store
  end
end

def ensure_database_store
  create_database_table

  existing = DB.exec_params(
    "SELECT data FROM jura_store WHERE id = $1",
    [1]
  )

  return unless existing.ntuples.zero?

  data = initial_store

  DB.exec_params(
    "INSERT INTO jura_store (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
    [1, JSON.generate(data)]
  )
end

def with_store
  DB_LOCK.synchronize do
    DB.exec("BEGIN")

    begin
      result = DB.exec_params(
        "SELECT data FROM jura_store WHERE id = $1 FOR UPDATE",
        [1]
      )

      data =
        if result.ntuples.zero?
          initial = initial_store

          DB.exec_params(
            "INSERT INTO jura_store (id, data) VALUES ($1, $2::jsonb)",
            [1, JSON.generate(initial)]
          )

          initial
        else
          normalize_store(JSON.parse(result[0]["data"]))
        end

      result = yield data

      DB.exec_params(
        "UPDATE jura_store SET data = $1::jsonb WHERE id = $2",
        [JSON.generate(data), 1]
      )

      DB.exec("COMMIT")

      result
    rescue StandardError
      DB.exec("ROLLBACK")
      raise
    end
  end
end

def request_user(request)
  cookie = request.cookies.find { |item| item.name == "jura_session" }
  return nil unless cookie

  SESSION_LOCK.synchronize { SESSIONS[cookie.value] }
end

def response_json(response, status, payload)
  response.status = status
  response["Content-Type"] = "application/json; charset=utf-8"
  response["Cache-Control"] = "no-store"
  response.body = JSON.generate(payload)
end

def request_json(request)
  JSON.parse(request.body.to_s)
rescue JSON::ParserError
  {}
end

def valid_entry?(entry)
  kind = entry["type"].to_s
  amount = entry["amount"].to_s
  status = entry["status"].to_s
  valid_amount = amount.empty? || amount.match?(/\A\d+(?:\.\d{1,2})?\z/)
  if kind == "expense"
    !entry["title"].to_s.strip.empty? && MEMBERS.include?(entry["paid_by"]) && %w[paid open].include?(status) && valid_amount
  elsif kind == "settlement"
    MEMBERS.include?(entry["participant"]) && MEMBERS.include?(entry["due_to"]) && entry["participant"] != entry["due_to"] && amount.match?(/\A\d+(?:\.\d{1,2})?\z/) && %w[paid open].include?(status)
  else
    false
  end
end

def valid_stay?(stay)
  stay["paid_by"].to_s.then { |paid_by| MEMBERS.include?(paid_by) } &&
    stay["amount"].to_s.match?(/\A\d+(?:\.\d{1,2})?\z/) &&
    %w[paid open].include?(stay["status"].to_s)
end

def normalize_activity_url(value)
  url = value.to_s.strip
  return "" if url.empty?

  candidate = url.match?(/\Ahttps?:\/\//i) ? url : "https://#{url}"
  parsed = URI.parse(candidate)
  return candidate if %w[http https].include?(parsed.scheme) && !parsed.host.to_s.empty?

  nil
rescue URI::InvalidURIError
  nil
end

def valid_activity?(activity)
  date = activity["date"].to_s
  time = activity["time"].to_s
  normalized_url = normalize_activity_url(activity["url"])
  valid_url = !normalized_url.nil?
  !activity["title"].to_s.strip.empty? && %w[2026-10-16 2026-10-17 2026-10-18 2026-10-19].include?(date) && (time.empty? || time.match?(/\A(?:[01]\d|2[0-3]):[0-5]\d\z/)) && valid_url
end

def can_manage_record?(record, user)
  user["role"] == "admin" && user["name"] == "Felix" ||
    record["created_by"] == user["name"] ||
    record["type"] == "expense" && record["paid_by"] == user["name"]
end

def authorized_user(request, response)
  user = request_user(request)
  response_json(response, 401, "error" => "Sign in to continue") unless user
  user
end

def secure_password_match?(given, expected)
  return false if expected.nil? || expected.empty? || given.bytesize != expected.bytesize

  difference = 0
  given.bytes.zip(expected.bytes) { |left, right| difference |= left ^ right }
  difference.zero?
end

def normalize_iban(value)
  value.to_s.upcase.gsub(/\s+/, "")
end

def valid_iban?(iban)
  return false unless (15..34).cover?(iban.length) && iban.match?(/\A[A-Z]{2}[0-9]{2}[A-Z0-9]+\z/)

  rearranged = iban[4..-1] + iban[0, 4]
  digits = rearranged.each_char.map { |character| character.match?(/[A-Z]/) ? (character.ord - 55).to_s : character }.join
  digits.each_char.reduce(0) { |remainder, digit| (remainder * 10 + digit.to_i) % 97 } == 1
end

load_dotenv
ensure_database_store

server = WEBrick::HTTPServer.new(
  Port: PORT,
  BindAddress: ENV.fetch("BIND_ADDRESS", "127.0.0.1"),
  DocumentRoot: ROOT,
  AccessLog: [],
  Logger: WEBrick::Log.new($stdout, WEBrick::Log::INFO)
)

server.mount_proc "/.jura-shared.json" do |_request, response|
  response_json(response, 404, "error" => "Not found")
end

server.mount_proc "/.env" do |_request, response|
  response_json(response, 404, "error" => "Not found")
end

server.mount_proc "/jura-trip.csv" do |request, response|
  if request_user(request)
    response.status = 200
    response["Content-Type"] = "text/csv; charset=utf-8"
    response["Cache-Control"] = "no-store"
    response.body = File.read(CSV_PATH)
  else
    response_json(response, 401, "error" => "Sign in to view trip data")
  end
end

server.mount_proc "/api" do |request, response|
  path = request.path

  if path == "/api/session" && request.request_method == "GET"
    user = request_user(request)
    registered_members = with_store { |data| data["member_ibans"].keys }
    response_json(response, 200, "user" => user, "registered_members" => registered_members, "felix_password_configured" => !ENV.fetch("FELIX_ADMIN_PASSWORD", "").empty?)
  elsif path == "/api/login" && request.request_method == "POST"
    body = request_json(request)
    name = body["name"].to_s
    iban = normalize_iban(body["iban"])
    if !MEMBERS.include?(name)
      response_json(response, 400, "error" => "Choose one of the four trip members")
    elsif name == "Felix" && ENV.fetch("FELIX_ADMIN_PASSWORD", "").empty?
      response_json(response, 503, "error" => "Felix admin access is not configured on this server")
    elsif name == "Felix" && !secure_password_match?(body["password"].to_s, ENV.fetch("FELIX_ADMIN_PASSWORD", ""))
      response_json(response, 401, "error" => "Incorrect Felix password")
    else
      registered = with_store do |data|
        stored_iban = data["member_ibans"][name]
        next :already_registered if stored_iban
        next :invalid_iban unless valid_iban?(iban)

        data["member_ibans"][name] = iban
        :registered
      end
      if registered == :invalid_iban
        response_json(response, 400, "error" => "Enter a valid IBAN for first-time sign-in")
      else
        token = SecureRandom.hex(32)
        user = { "name" => name, "role" => name == "Felix" ? "admin" : "member" }
        SESSION_LOCK.synchronize { SESSIONS[token] = user }
        secure_cookie = ENV["COOKIE_SECURE"] == "true" ? "; Secure" : ""
        response["Set-Cookie"] = "jura_session=#{token}; Path=/; HttpOnly; SameSite=Strict#{secure_cookie}"
        response_json(response, 200, "user" => user)
      end
    end
  elsif path == "/api/logout" && request.request_method == "POST"
    cookie = request.cookies.find { |item| item.name == "jura_session" }
    SESSION_LOCK.synchronize { SESSIONS.delete(cookie.value) } if cookie
    response["Set-Cookie"] = "jura_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    response_json(response, 200, "user" => nil)
  elsif ["/api/member-iban", "/api/member-iban/clear"].include?(path) && request.request_method == "POST"
    user = authorized_user(request, response)
    next unless user

    body = request_json(request)
    iban = normalize_iban(body["iban"])
    if path == "/api/member-iban/clear" || body["action"] == "clear" || iban.empty?
      with_store { |data| data["member_ibans"].delete(user["name"]) }
      response_json(response, 200, "member_iban" => "")
      next
    end
    unless valid_iban?(iban)
      response_json(response, 400, "error" => "Enter a valid IBAN")
      next
    end

    with_store { |data| data["member_ibans"][user["name"]] = iban }
    response_json(response, 200, "member_iban" => iban)
  elsif path == "/api/trip" && request.request_method == "GET"
    user = authorized_user(request, response)
    next unless user

    records = CSV.read(CSV_PATH, headers: true).map(&:to_h)
    member_ibans, stay = with_store { |data| [data["member_ibans"], data["stay"]] }
    records.reject! { |record| record["type"] == "stay" && stay["deleted"] }
    records.map! { |record| record["type"] == "stay" && !stay.empty? ? stay : record }
    response_json(response, 200, "records" => records, "member_ibans" => member_ibans)
  elsif path == "/api/stay" && request.request_method == "POST"
    user = authorized_user(request, response)
    next unless user

    body = request_json(request)
    result = with_store do |data|
      stay = data["stay"] || seeded_stay
      next :forbidden unless can_manage_record?(stay, user)

      if body["action"] == "delete"
        data["stay"] = stay.merge("deleted" => true)
        next :deleted
      end

      updated = stay.merge(body.slice("paid_by", "amount", "status"))
      updated["type"] = "stay"
      updated["id"] ||= "stay-01"
      updated["created_by"] ||= "Felix"
      next :invalid unless valid_stay?(updated)

      data["stay"] = updated
      updated
    end
    if result == :forbidden
      response_json(response, 403, "error" => "Only the accommodation owner or Felix can edit this payment")
    elsif result == :invalid
      response_json(response, 400, "error" => "Check the accommodation payment details")
    elsif result == :deleted
      response_json(response, 200, "deleted" => true)
    else
      response_json(response, 200, "entry" => result)
    end
  elsif path == "/api/activities" && request.request_method == "GET"
    user = authorized_user(request, response)
    next unless user

    activities = with_store { |data| data["activities"] }
    response_json(response, 200, "activities" => activities)
  elsif path == "/api/activities" && request.request_method == "POST"
    user = authorized_user(request, response)
    next unless user

    body = request_json(request)
    unless valid_activity?(body)
      response_json(response, 400, "error" => "Check the activity title, date, and time")
      next
    end

    activity = {
      "id" => SecureRandom.hex(12), "date" => body["date"], "time" => body["time"].to_s,
      "title" => body["title"].to_s.strip, "location" => body["location"].to_s.strip,
      "details" => body["details"].to_s.strip, "url" => normalize_activity_url(body["url"]), "status" => "pending",
      "created_by" => user["name"], "likes" => []
    }
    with_store { |data| data["activities"] << activity }
    response_json(response, 201, "activity" => activity)
  elsif path.match?(%r{\A/api/activities/[^/]+\z}) && path != "/api/activities/action" && request.request_method == "POST"
    user = authorized_user(request, response)
    next unless user

    activity_id = path.split("/").last
    body = request_json(request)
    result = with_store do |data|
      index = data["activities"].index { |activity| activity["id"] == activity_id }
      next :not_found unless index

      activity = data["activities"][index]
      next :forbidden unless can_manage_record?(activity, user)

      if body["action"] == "delete"
        data["activities"].delete_at(index)
        :deleted
      elsif body["action"] == "update"
        changes = body.slice("date", "time", "title", "location", "details", "url")
        changes["url"] = normalize_activity_url(changes["url"]) if changes.key?("url")
        updated = activity.merge(changes)
        next :invalid unless valid_activity?(updated)
        data["activities"][index] = updated
      else
        :invalid
      end
    end
    if result == :not_found
      response_json(response, 404, "error" => "Activity not found")
    elsif result == :forbidden
      response_json(response, 403, "error" => "Only the author or Felix can manage this activity")
    elsif result == :invalid
      response_json(response, 400, "error" => "Unknown action or invalid activity details")
    elsif result == :deleted
      response_json(response, 200, "deleted" => true)
    else
      response_json(response, 200, "activity" => result)
    end
  elsif path == "/api/entries" && request.request_method == "GET"
    user = authorized_user(request, response)
    next unless user

    entries = with_store { |data| data["entries"] }
    response_json(response, 200, "entries" => entries)
  elsif path == "/api/entries" && request.request_method == "POST"
    user = authorized_user(request, response)
    next unless user

    body = request_json(request)
    unless valid_entry?(body)
      response_json(response, 400, "error" => "Check the expense or payment details")
      next
    end

    entry = body.slice("type", "title", "details", "paid_by", "amount", "participant", "due_to", "status")
    entry["split"] = 4 if entry["type"] == "expense"
    entry["id"] = SecureRandom.hex(12)
    entry["created_by"] = user["name"]
    with_store { |data| data["entries"] << entry }
    response_json(response, 201, "entry" => entry)
  elsif path.match?(%r{\A/api/entries/[^/]+\z}) && request.request_method == "POST"
    user = authorized_user(request, response)
    next unless user

    entry_id = path.split("/").last
    body = request_json(request)
    result = with_store do |data|
      index = data["entries"].index { |entry| entry["id"] == entry_id }
      next :not_found unless index

      entry = data["entries"][index]
      next :forbidden unless can_manage_record?(entry, user)

      if body["action"] == "delete"
        data["entries"].delete_at(index)
        :deleted
      elsif body["action"] == "update"
        changes = body.slice("type", "title", "details", "paid_by", "amount", "participant", "due_to", "status")
        updated = entry.merge(changes)
        next :invalid unless valid_entry?(updated)
        updated["split"] = 4 if updated["type"] == "expense"
        data["entries"][index] = updated
      else
        :invalid
      end
    end
    if result == :not_found
      response_json(response, 404, "error" => "Entry not found")
    elsif result == :forbidden
      response_json(response, 403, "error" => "Only the author or Felix can manage this entry")
    elsif result == :invalid
      response_json(response, 400, "error" => "Unknown action or invalid expense details")
    elsif result == :deleted
      response_json(response, 200, "deleted" => true)
    else
      response_json(response, 200, "entry" => result)
    end
  elsif path == "/api/activities/action" && request.request_method == "POST"
    user = authorized_user(request, response)
    next unless user

    body = request_json(request)
    activity = with_store do |data|
      row = data["activities"].find { |item| item["id"] == body["id"] }
      next nil unless row

      if body["action"] == "confirm"
        next :forbidden unless user["role"] == "admin" && user["name"] == "Felix"
        row["status"] = "done"
      elsif body["action"] == "unconfirm"
        next :forbidden unless user["role"] == "admin" && user["name"] == "Felix"
        row["status"] = "pending"
      elsif body["action"] == "like"
        likes = row["likes"] ||= []
        likes.include?(user["name"]) ? likes.delete(user["name"]) : likes << user["name"]
      else
        next :invalid
      end
      row
    end
    if activity == :forbidden
      response_json(response, 403, "error" => "Only Felix can confirm or reopen an activity")
    elsif activity == :invalid
      response_json(response, 400, "error" => "Unknown activity action")
    elsif activity.nil?
      response_json(response, 404, "error" => "Activity not found")
    else
      response_json(response, 200, "activity" => activity)
    end
  else
    response_json(response, 404, "error" => "Not found")
  end
rescue StandardError => error
  warn "API error: #{error.class}: #{error.message}"
  response_json(response, 500, "error" => "The request could not be completed")
end

trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }
puts "Jura trip server listening at http://#{server.config[:BindAddress]}:#{PORT}"
puts "Felix admin password configured: #{!ENV.fetch('FELIX_ADMIN_PASSWORD', '').empty?}"
server.start
