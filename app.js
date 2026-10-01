const PEOPLE = ["Kai", "Giulio", "Lucia", "Felix"];
const DATES = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"];
const HEADERS = ["type", "id", "date", "title", "details", "location", "host", "paid_by", "amount", "participant", "due_to", "status", "arrival", "departure", "time"];
const previewMode = new URLSearchParams(window.location.search).get("preview") === "1";
let records = [];
let activeKind = "";
let currentUser = null;
let memberIbans = {};
let registeredMembers = [];
let tripDataLoaded = false;
let pendingEntryKind = "";
let pendingLikeId = "";
let editingRecordId = "";
let activePaymentTarget = "";
let pendingDelete = null;
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = (value) => value === "" || value == null ? "Not entered" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(Number(value));
const activityUrl = (value = "") => {
  const raw = String(value).trim();
  if (!raw) return "";
  const url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (_) {
    return "";
  }
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2500);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const responseText = await response.text();
  let payload = {};
  try { payload = responseText ? JSON.parse(responseText) : {}; }
  catch (_) { payload = { error: responseText || "Request failed (" + response.status + ")" }; }
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function updateAccountControl() {
  const signedIn = Boolean(currentUser);
  $("#sign-in-button").hidden = Boolean(currentUser);
  $("#sign-out-button").hidden = !currentUser;
  $("#signed-in-as").hidden = !currentUser;
  $("#signed-in-as").textContent = currentUser ? currentUser.name : "";
  $("#member-avatar").textContent = currentUser ? currentUser.name[0].toUpperCase() : "?";
  $("#trip-shell").hidden = !signedIn || !tripDataLoaded;
  $("#auth-gate").hidden = signedIn && tripDataLoaded;
}

function replaceActivity(activity) {
  const index = records.findIndex((row) => row.type === "activity" && row.id === activity.id);
  const record = { ...activity, type: "activity" };
  if (index < 0) records.push(record);
  else records[index] = record;
}

async function refreshActivities() {
  const { activities } = await apiRequest("/api/activities");
  records = records.filter((row) => row.type !== "activity");
  activities.forEach(replaceActivity);
  renderTimeline();
  updateDashboardSummary();
}

async function refreshEntries() {
  const { entries } = await apiRequest("/api/entries");
  records = records.filter((row) => !["expense", "settlement"].includes(row.type));
  records.push(...entries);
  renderAccounts();
  updateDashboardSummary();
}

function updateDashboardSummary() {
  const summary = accountBalances();
  const totalSpent = summary.paidExpenses.reduce((total, row) => total + (Number(row.amount) || 0), 0);
  const entryCount = records.filter((row) => ["expense", "stay", "settlement"].includes(row.type)).length;
  const latestActivity = records.filter((row) => row.type === "activity").slice(-1)[0];
  const totalSpentElement = $("#dashboard-total-spent");
  const expenseCountElement = $("#dashboard-expense-count");
  const latestActivityElement = $("#dashboard-latest-activity");
  if (totalSpentElement) totalSpentElement.textContent = `${money(totalSpent)} spent`;
  if (expenseCountElement) expenseCountElement.textContent = `${entryCount} ${entryCount === 1 ? "account entry" : "account entries"}`;
  if (latestActivityElement) latestActivityElement.textContent = latestActivity ? `${latestActivity.title} · ${formatDate(latestActivity.date)} · ${latestActivity.status === "done" ? "Confirmed" : "Awaiting confirmation"}` : "No activities yet";
}

async function loadTripData() {
  const [trip, activityPayload, entryPayload] = await Promise.all([
    apiRequest("/api/trip"),
    apiRequest("/api/activities"),
    apiRequest("/api/entries")
  ]);
  records = trip.records.filter((row) => row.type === "stay");
  records.push(...entryPayload.entries);
  activityPayload.activities.forEach(replaceActivity);
  memberIbans = trip.member_ibans || {};
  tripDataLoaded = true;
  updateAccountControl();
  render();
}

function openSignIn() {
  if (!$("#sign-in-dialog").open) $("#sign-in-dialog").showModal();
}

function openMemberSettings() {
  if (!currentUser) return openSignIn();
  $("#member-iban-edit").value = memberIbans[currentUser.name] || "";
  $("#member-iban-hint").textContent = "Your updated IBAN will be used wherever payment details are shown.";
  $("#member-iban-hint").classList.remove("form-hint-error");
  $("#member-dialog").showModal();
}

function updateSignInFields(name) {
  const needsIban = Boolean(name) && !registeredMembers.includes(name);
  const needsFelixPassword = name === "Felix";
  $("#member-iban-group").hidden = !needsIban;
  $("#member-iban").required = needsIban;
  $("#felix-password-field").hidden = !needsFelixPassword;
  $("#member-password").required = needsFelixPassword;
  if (!name) $("#sign-in-hint").textContent = "Choose your name to join the trip.";
  else if (needsIban) $("#sign-in-hint").textContent = "First sign-in: add your payment IBAN once.";
  else $("#sign-in-hint").textContent = needsFelixPassword ? "Enter your admin password to continue." : "Select your name and continue.";
}

function openDeleteConfirmation(type, record) {
  pendingDelete = { type, id: record.id };
  $("#delete-dialog-title").textContent = `Delete ${record.title || (type === "activity" ? "activity" : "expense")}?`;
  $("#delete-dialog-message").textContent = "This will remove the shared item for everyone in the trip.";
  $("#delete-dialog").showModal();
}

async function copyIban(button) {
  const iban = button.dataset.copyIban;
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(iban);
      copied = true;
    }
  } catch {}
  if (!copied) {
    const field = document.createElement("textarea");
    field.value = iban;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    copied = document.execCommand("copy");
    field.remove();
  }
  if (copied) {
    button.textContent = "Copied";
    window.setTimeout(() => { if (button.isConnected) button.textContent = "Copy"; }, 1400);
  } else showToast("Could not copy IBAN");
}

function removeEntryFromView(id) {
  records = records.filter((row) => row.id !== id);
  render();
}

function accountBalances() {
  const balances = Object.fromEntries(PEOPLE.map((person) => [person, 0]));
  const obligations = Object.fromEntries(PEOPLE.map((person) => [person, Object.fromEntries(PEOPLE.map((other) => [other, 0]))]));
  const paidExpenses = records.filter((row) => ["expense", "stay"].includes(row.type) && row.status !== "open" && Number(row.amount) > 0);
  for (const row of paidExpenses) {
    const cents = Math.round(Number(row.amount) * 100);
    const share = Math.floor(cents / PEOPLE.length);
    const extraCents = cents % PEOPLE.length;
    PEOPLE.forEach((person, index) => { balances[person] -= share + (index < extraCents ? 1 : 0); });
    if (PEOPLE.includes(row.paid_by)) {
      balances[row.paid_by] += cents;
      PEOPLE.forEach((person, index) => {
        if (person !== row.paid_by) obligations[person][row.paid_by] += share + (index < extraCents ? 1 : 0);
      });
    }
  }
  for (const row of records.filter((entry) => entry.type === "settlement" && entry.status === "paid")) {
    const cents = Math.round(Number(row.amount) * 100);
    if (PEOPLE.includes(row.participant)) balances[row.participant] -= cents;
    if (PEOPLE.includes(row.due_to)) balances[row.due_to] += cents;
    if (PEOPLE.includes(row.participant) && PEOPLE.includes(row.due_to)) obligations[row.participant][row.due_to] -= cents;
  }

  const transfers = [];
  PEOPLE.forEach((person, personIndex) => {
    PEOPLE.slice(personIndex + 1).forEach((other) => {
      const net = obligations[person][other] - obligations[other][person];
      if (net > 0) transfers.push({ from: person, to: other, cents: net });
      if (net < 0) transfers.push({ from: other, to: person, cents: -net });
    });
  });
  return { balances, paidExpenses, transfers };
}

function personCard(person, summary) {
  const paidRows = summary.paidExpenses.filter((row) => row.paid_by === person);
  const paidSum = paidRows.reduce((total, row) => total + (Number(row.amount) || 0), 0);
  const fairShare = summary.paidExpenses.reduce((total, row) => total + (Number(row.amount) || 0) / PEOPLE.length, 0);
  const balanceCents = summary.balances[person];
  const personTransfers = summary.transfers.filter((transfer) => transfer.from === person || transfer.to === person);
  const remainder = personTransfers.length ? personTransfers.map((transfer) => {
    if (transfer.from === person) {
      const amount = money(transfer.cents / 100);
      const payAction = currentUser?.name === person ? `<button class="pay-transfer" type="button" data-pay-to="${escapeHtml(transfer.to)}" data-pay-amount="${(transfer.cents / 100).toFixed(2)}">Pay ${escapeHtml(transfer.to)} · ${escapeHtml(amount)}</button>` : `<span>Pay ${escapeHtml(transfer.to)} ${escapeHtml(amount)}</span>`;
      return `<div>${payAction}</div>`;
    }
    return `<div>Receive ${escapeHtml(money(transfer.cents / 100))} from ${escapeHtml(transfer.from)}</div>`;
  }).join("") : `<div>${balanceCents === 0 ? "All settled" : "No payment needed"}</div>`;
  const balanceClass = balanceCents > 0 ? "money-positive" : balanceCents < 0 ? "money-open" : "";
  const signedBalance = balanceCents > 0 ? `+${money(balanceCents / 100)}` : balanceCents < 0 ? `−${money(Math.abs(balanceCents) / 100)}` : money(0);
  return `<article class="person">
    <div class="person-head"><span class="person-initial">${person[0]}</span><span class="person-name">${person}</span></div>
    <div class="person-stat"><span>Paid</span><strong>${escapeHtml(money(paidSum))}</strong></div>
    <div class="person-stat"><span>Share (÷ 4)</span><strong>${escapeHtml(money(fairShare))}</strong></div>
    <div class="person-stat"><span>Remainder</span><strong class="${balanceClass}">${escapeHtml(signedBalance)}</strong></div>
    <div class="person-remainder">${remainder}</div>
  </article>`;
}

function memberIcon(person) {
  const name = PEOPLE.includes(person) ? person : "Unknown member";
  const initial = PEOPLE.includes(person) ? person[0] : "?";
  return `<span class="member-chip" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">${initial}</span>`;
}

function renderAccounts() {
  const summary = accountBalances();
  $("#people-grid").innerHTML = PEOPLE.map((person) => personCard(person, summary)).join("");
  const entries = records.filter((row) => ["expense", "stay", "settlement"].includes(row.type));
  $("#ledger-count").textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  const expenseRows = entries.map((row) => {
    const isDebt = row.type === "settlement";
    const payerLabel = isDebt ? `${memberIcon(row.participant)}<span class="payer-arrow" aria-hidden="true">→</span>${memberIcon(row.due_to)}` : memberIcon(row.paid_by);
    const state = row.status === "paid" ? "paid" : row.status === "open" ? "open" : "neutral";
    const statusText = row.status === "paid" ? "Paid" : row.status === "open" ? "To pay" : "To confirm";
    const splitDetail = [row.details, ["expense", "stay"].includes(row.type) ? `Shared equally · ${money((Number(row.amount) || 0) / PEOPLE.length)} each` : ""].filter(Boolean).join(" · ");
    const canManage = currentUser && (currentUser.role === "admin" || row.created_by === currentUser.name || (row.type === "expense" && row.paid_by === currentUser.name));
    const actions = canManage && ["expense", "settlement", "stay"].includes(row.type) ? `<div class="expense-actions"><button class="expense-action" type="button" data-edit-entry="${escapeHtml(row.id)}">Edit</button><button class="expense-action" type="button" data-delete-entry="${escapeHtml(row.id)}">Delete</button></div>` : "";
    return `<div class="expense-row">
      <div class="expense-name">${escapeHtml(row.title || (isDebt ? "Payment" : "Expense"))}<span class="expense-detail">${escapeHtml(splitDetail || (isDebt ? `Owes ${row.due_to || ""}` : ""))}</span></div>
      <div class="expense-payer"><span class="status-label status-${state}">${statusText}</span>${payerLabel}</div>
      <div class="expense-amount">${escapeHtml(money(row.amount))}</div>
      ${actions}
    </div>`;
  });
  $("#expense-list").innerHTML = expenseRows.length ? expenseRows.join("") : `<p class="empty-state">No expenses or payments added yet.</p>`;
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function renderTimeline() {
  const columnHead = `<div class="timeline-head"><span>Day</span><div class="timeline-head-content"><span>Activity</span><span>Status</span><span>Likes</span></div></div>`;
  $("#timeline").innerHTML = columnHead + DATES.map((date) => {
    const dayActivities = records.filter((row) => row.type === "activity" && row.date === date).sort((first, second) => (first.time || "99:99").localeCompare(second.time || "99:99"));
    const content = dayActivities.length ? dayActivities.map((row) => {
      const status = row.status === "done" ? "confirmed" : "neutral";
      const isProposal = row.status !== "done";
      const previewDisabled = previewMode ? ' disabled aria-disabled="true"' : "";
      const label = isProposal ? "Proposal · awaiting confirmation" : "Confirmed";
      const time = row.time ? `<time datetime="${escapeHtml(`${row.date}T${row.time}`)}">${escapeHtml(row.time)}</time>` : "";
      const url = activityUrl(row.url);
      const link = url ? '<a class="activity-link" href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">Open website <img src="arrow-icon.png" alt="" aria-hidden="true"></a>' : "";
      const details = [time, escapeHtml(row.location), escapeHtml(row.details)].filter(Boolean).join(" · ");
      const activityDetail = [details, link].filter(Boolean).join("");
      const liked = currentUser && (row.likes || []).includes(currentUser.name);
      const likerNames = row.likes || [];
      const isAdmin = currentUser?.role === "admin" && currentUser?.name === "Felix";
      const likeButton = !isAdmin || isProposal ? `<button class="activity-like" type="button" data-like-activity="${escapeHtml(row.id)}" aria-pressed="${Boolean(liked)}"${previewDisabled}>${liked ? "Liked" : "Like"}</button>` : "";
      const confirmButton = isProposal && isAdmin ? `<button class="activity-confirm" type="button" data-confirm-activity="${escapeHtml(row.id)}"${previewDisabled}>Confirm</button>` : "";
      const canManage = currentUser && (isAdmin || row.created_by === currentUser.name);
      const editDelete = canManage ? `<button class="activity-action" type="button" data-edit-activity="${escapeHtml(row.id)}"${previewDisabled}>Edit</button><button class="activity-action" type="button" data-delete-activity="${escapeHtml(row.id)}"${previewDisabled}>Delete</button>` : "";
      const undoConfirm = row.status === "done" && isAdmin ? `<button class="activity-action" type="button" data-unconfirm-activity="${escapeHtml(row.id)}"${previewDisabled}>Undo confirmation</button>` : "";
      const likerIcons = likerNames.map(memberIcon).join("");
      const likerLabel = likerNames.length ? `Liked by ${likerNames.join(", ")}` : "No likes yet";
      return `<div class="activity"><div class="activity-main"><span class="activity-title">${escapeHtml(row.title)}</span><span class="activity-detail">${activityDetail}</span></div><div class="activity-status-column"><span class="status-label status-${status} activity-status">${label}</span><div class="activity-actions">${confirmButton}${undoConfirm}${editDelete}</div></div><div class="activity-likes" aria-label="${escapeHtml(likerLabel)}"><div class="like-avatars">${likerIcons}</div>${likeButton}</div></div>`;
    }).join("") : `<div class="activity-empty">Nothing planned yet</div>`;
    const dateBits = formatDate(date).split(" ");
    return `<article class="day-row"><div class="day-label"><span class="day-name">${dateBits[0]}</span><span class="day-date">${dateBits.slice(1).join(" ")}</span></div><div class="day-entries">${content}</div></article>`;
  }).join("");
}

function render() {
  renderAccounts();
  renderTimeline();
  updateDashboardSummary();
}

function setView() {
  const view = new URLSearchParams(window.location.search).get("view") || "dashboard";
  const navigation = performance.getEntriesByType("navigation")[0];
  const requestedView = navigation?.type === "reload" ? "dashboard" : view;
  const validViews = ["dashboard", "accounts", "itinerary", "stay"];
  const activeView = validViews.includes(requestedView) ? requestedView : "dashboard";
  const viewTitles = { dashboard: "Jura", accounts: "Accounts", itinerary: "Timeline", stay: "Accommodation" };
  validViews.forEach((name) => { $(`#${name}`).hidden = name !== activeView; });
  if (previewMode) {
    document.querySelectorAll('a[href^="?view="]').forEach((link) => {
      const target = new URL(link.href, window.location.href);
      target.searchParams.set("preview", "1");
      link.href = `${target.pathname}${target.search}${target.hash}`;
    });
  }
  document.body.classList.toggle("dashboard-view", activeView === "dashboard");
  document.title = `${viewTitles[activeView]} / October 2026`;
}

function initLandingMotion() {
  const animated = document.querySelectorAll(".landing-hero, .landing-panel");
  if (!animated.length) return;
  if ("IntersectionObserver" in window) {
    const reveal = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) reveal.unobserve(entry.target), entry.target.classList.add("is-visible");
      });
    }, { threshold: 0.15 });
    animated.forEach((element) => reveal.observe(element));
  } else animated.forEach((element) => element.classList.add("is-visible"));

  const images = document.querySelectorAll(".landing-panel-image img, .landing-panel-image-only > img");
  let ticking = false;
  const moveImages = () => {
    images.forEach((image) => {
      const bounds = image.closest(".landing-panel").getBoundingClientRect();
      const offset = Math.max(-22, Math.min(22, (window.innerHeight / 2 - (bounds.top + bounds.height / 2)) * 0.045));
      image.style.transform = `translateY(${offset}px)`;
    });
    ticking = false;
  };
  window.addEventListener("scroll", () => {
    if (!ticking) window.requestAnimationFrame(moveImages), ticking = true;
  }, { passive: true });
  moveImages();
}

function field(name, label, options = {}) {
  const id = `field-${name}`;
  const required = options.required ? "required" : "";
  if (options.select) return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}" ${required}>${options.select.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select></div>`;
  if (options.textarea) return `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" name="${name}" ${required} placeholder="${escapeHtml(options.placeholder || "")}"></textarea></div>`;
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${name}" type="${options.type || "text"}" ${required} ${options.step ? `step="${options.step}"` : ""} placeholder="${escapeHtml(options.placeholder || "")}"></div>`;
}

function openEntry(kind, existingRecord = null, presetValues = {}) {
  if (!currentUser) {
    pendingEntryKind = kind;
    openSignIn();
    return;
  }
  activeKind = kind;
  activePaymentTarget = kind === "payment" ? presetValues.due_to || "" : "";
  editingRecordId = existingRecord?.id || "";
  const configs = {
    activity: {
      title: "Propose an activity", fields: field("date", "Day", { type: "date", required: true }) + field("time", "Time (optional)", { type: "time" }) + field("title", "Activity", { required: true }) + field("location", "Place") + field("url", "Website URL", { type: "url", placeholder: "https://…" }) + field("details", "Notes", { textarea: true })
    },
    expense: {
      title: "Add an expense", fields: field("title", "What was it for?", { required: true }) + field("details", "Notes") + field("paid_by", "Paid by", { select: PEOPLE.map((person) => ({ value: person, label: person })) }) + field("amount", "Amount in EUR", { type: "number", step: "0.01", placeholder: "Leave blank if unknown" }) + field("status", "Payment status", { select: [{ value: "paid", label: "Paid" }, { value: "open", label: "Still to pay" }] })
    },
    stay: {
      title: "Edit accommodation payment", fields: field("paid_by", "Paid by", { select: PEOPLE.map((person) => ({ value: person, label: person })) }) + field("amount", "Amount in EUR", { type: "number", step: "0.01", required: true }) + field("status", "Payment status", { select: [{ value: "paid", label: "Paid" }, { value: "open", label: "Still to pay" }] })
    },
    settlement: {
      title: "Add a payment", fields: field("participant", "Who owes?", { select: PEOPLE.map((person) => ({ value: person, label: person })) }) + field("due_to", "Paying to", { select: PEOPLE.map((person) => ({ value: person, label: person })) }) + field("amount", "Amount in EUR", { type: "number", step: "0.01", required: true }) + field("status", "Status", { select: [{ value: "open", label: "Still to pay" }, { value: "paid", label: "Settled" }] })
    }
  };
  const config = kind === "payment"
    ? { title: `Pay ${activePaymentTarget}`, fields: field("amount", "Amount in EUR", { type: "number", step: "0.01", required: true, placeholder: "Enter the amount sent" }) }
    : configs[kind];
  const hints = {
    activity: "Your proposal will be visible to all signed-in members. Add one website URL; saving a new one replaces the previous link.",
    expense: "A €100 dinner adds €25 to each share and gives the payer €75 net credit. Add an expense to compensate or pay directly; preferably settle the remainder at the very end.",
    stay: "The accommodation cost is split equally four ways.",
    settlement: "Record a payment from one member to another. Paid transfers reduce the remaining balance.",
    payment: "Enter the amount you sent. It will reduce the amount you owe."
  };
  $("#dialog-title").textContent = existingRecord ? `Edit ${kind === "activity" ? "activity" : kind === "settlement" ? "payment" : kind === "stay" ? "accommodation payment" : "expense"}` : config.title;
  $("#entry-hint").textContent = existingRecord ? "Your changes will be shared with the trip." : hints[kind];
  $("#entry-hint").classList.remove("form-hint-error");
  $("#submit-entry").textContent = existingRecord ? "Save changes" : kind === "activity" ? "Submit proposal" : kind === "payment" ? "Record payment" : "Add to trip";
  const recipientIban = memberIbans[activePaymentTarget] || "";
  $("#payment-recipient").hidden = kind !== "payment";
  $("#tip-actions").hidden = kind !== "payment";
  $("#payment-recipient-name").textContent = activePaymentTarget;
  $("#payment-recipient-iban").textContent = recipientIban || "IBAN not added yet";
  $("#copy-payment-iban").hidden = !recipientIban;
  $("#copy-payment-iban").dataset.copyIban = recipientIban;
  $("#form-fields").innerHTML = config.fields;
  const initialValues = existingRecord || presetValues;
  if (initialValues) {
    Object.entries(initialValues).forEach(([name, value]) => {
      const control = $(`#field-${name}`);
      if (control) control.value = value ?? "";
    });
  }
  if (kind === "activity") $("#field-date").min = DATES[0], $("#field-date").max = DATES[3];
  $("#entry-dialog").showModal();
}

$("#entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = $("#submit-entry");
  const values = Object.fromEntries(new FormData(form).entries());
  if (activeKind === "settlement" && values.participant === values.due_to) { showToast("Choose two different people"); return; }
  const isEditing = Boolean(editingRecordId);
  const entryKind = activeKind === "payment" ? "settlement" : activeKind;
  const record = { ...Object.fromEntries(HEADERS.map((header) => [header, ""])), ...values, type: entryKind, participant: activeKind === "payment" ? currentUser.name : values.participant, due_to: activeKind === "payment" ? activePaymentTarget : values.due_to, status: activeKind === "activity" ? (isEditing ? records.find((row) => row.id === editingRecordId)?.status || "pending" : "pending") : activeKind === "payment" ? "paid" : values.status, id: editingRecordId || `${entryKind}-${Date.now()}` };
  if (activeKind === "activity") {
    try {
      const route = isEditing ? `/api/activities/${encodeURIComponent(editingRecordId)}` : "/api/activities";
      const payload = isEditing ? { ...record, action: "update" } : record;
      const { activity } = await apiRequest(route, { method: "POST", body: JSON.stringify(payload) });
      replaceActivity(activity);
      $("#entry-dialog").close();
      form.reset();
      editingRecordId = "";
      renderTimeline();
      showToast(isEditing ? "Activity updated" : "Proposal shared with the trip");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  try {
    submitButton.disabled = true;
    submitButton.textContent = "Saving…";
    const isStay = activeKind === "stay";
    const route = isStay ? "/api/stay" : isEditing ? `/api/entries/${encodeURIComponent(editingRecordId)}` : "/api/entries";
    const payload = isEditing ? { ...record, action: "update" } : record;
    const { entry } = await apiRequest(route, { method: "POST", body: JSON.stringify(payload) });
    if (isStay) {
      const index = records.findIndex((row) => row.type === "stay");
      if (index >= 0) records[index] = entry;
      else records.push(entry);
    } else if (isEditing) {
      const index = records.findIndex((row) => row.id === entry.id);
      if (index >= 0) records[index] = entry;
    } else records.push(entry);
    $("#entry-dialog").close();
    form.reset();
    editingRecordId = "";
    activePaymentTarget = "";
    $("#payment-recipient").hidden = true;
    render();
    showToast(isEditing ? "Entry updated" : activeKind === "payment" ? "Payment recorded" : "Added to the shared accounts");
  } catch (error) {
    $("#entry-hint").textContent = error.message;
    $("#entry-hint").classList.add("form-hint-error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = isEditing ? "Save changes" : activeKind === "activity" ? "Submit proposal" : activeKind === "payment" ? "Record payment" : "Add to trip";
  }
});

document.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => openEntry(button.dataset.open)));
$("#copy-payment-iban").addEventListener("click", (event) => copyIban(event.currentTarget));
document.querySelectorAll("[data-tip]").forEach((button) => button.addEventListener("click", () => window.alert("Just kidding")));
$("#people-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy-iban]");
  if (button) {
    copyIban(button);
    return;
  }
  const payButton = event.target.closest("[data-pay-to]");
  if (!payButton) return;
  event.preventDefault();
  if (!currentUser) {
    openSignIn();
    return;
  }
  openEntry("payment", null, {
    participant: currentUser.name,
    due_to: payButton.dataset.payTo,
    amount: payButton.dataset.payAmount,
    status: "paid"
  });
});
$("#expense-list").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-entry]");
  const deleteButton = event.target.closest("[data-delete-entry]");
  if (editButton) {
    const record = records.find((row) => row.id === editButton.dataset.editEntry);
    if (record) openEntry(record.type, record);
    return;
  }
  if (!deleteButton) return;
  const record = records.find((row) => row.id === deleteButton.dataset.deleteEntry);
  if (record) openDeleteConfirmation(record.type === "stay" ? "stay" : "entry", record);
});
$("#timeline").addEventListener("click", (event) => {
  const button = event.target.closest("[data-confirm-activity], [data-like-activity], [data-edit-activity], [data-delete-activity], [data-unconfirm-activity]");
  if (!button) return;
  const activityId = button.dataset.editActivity || button.dataset.deleteActivity || button.dataset.confirmActivity || button.dataset.likeActivity || button.dataset.unconfirmActivity;
  const record = records.find((row) => row.id === activityId);
  if (button.dataset.editActivity) {
    if (record) openEntry("activity", record);
    return;
  }
  if (button.dataset.deleteActivity) {
    if (record) openDeleteConfirmation("activity", record);
    return;
  }
  if (!currentUser) {
    pendingLikeId = button.dataset.likeActivity || "";
    openSignIn();
    return;
  }
  const action = button.dataset.confirmActivity ? "confirm" : button.dataset.unconfirmActivity ? "unconfirm" : "like";
  const id = button.dataset.confirmActivity || button.dataset.likeActivity || button.dataset.unconfirmActivity;
  apiRequest("/api/activities/action", { method: "POST", body: JSON.stringify({ id, action }) }).then(({ activity }) => {
    replaceActivity(activity);
    renderTimeline();
    showToast(action === "confirm" ? "Proposal confirmed" : action === "unconfirm" ? "Confirmation undone" : "Reaction saved");
  }).catch((error) => showToast(error.message));
});
$("#close-dialog").addEventListener("click", () => { editingRecordId = ""; $("#entry-dialog").close(); });
$("#cancel-dialog").addEventListener("click", () => { editingRecordId = ""; $("#entry-dialog").close(); });
$("#close-delete").addEventListener("click", () => $("#delete-dialog").close());
$("#cancel-delete").addEventListener("click", () => $("#delete-dialog").close());
$("#delete-dialog").addEventListener("close", () => { pendingDelete = null; });
$("#confirm-delete").addEventListener("click", async () => {
  if (!pendingDelete) return;
  const target = pendingDelete;
  const route = target.type === "activity" ? `/api/activities/${encodeURIComponent(target.id)}` : target.type === "stay" ? "/api/stay" : `/api/entries/${encodeURIComponent(target.id)}`;
  const button = $("#confirm-delete");
  button.disabled = true;
  try {
    await apiRequest(route, { method: "POST", body: JSON.stringify({ action: "delete" }) });
    records = records.filter((row) => row.id !== target.id);
    $("#delete-dialog").close();
    render();
    showToast(target.type === "activity" ? "Activity deleted" : "Entry deleted");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#sign-in-button").addEventListener("click", openSignIn);
$("#gate-sign-in").addEventListener("click", openSignIn);
$("#member-avatar").addEventListener("click", openMemberSettings);
$("#close-sign-in").addEventListener("click", () => $("#sign-in-dialog").close());
$("#close-member-dialog").addEventListener("click", () => $("#member-dialog").close());
$("#cancel-member-dialog").addEventListener("click", () => $("#member-dialog").close());
$("#member-name").addEventListener("change", (event) => {
  updateSignInFields(event.target.value);
});
$("#sign-in-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    const { user } = await apiRequest("/api/login", { method: "POST", body: JSON.stringify(values) });
    currentUser = user;
    if (!registeredMembers.includes(user.name)) registeredMembers.push(user.name);
    await loadTripData();
    $("#sign-in-dialog").close();
    form.reset();
    updateSignInFields("");
    if (pendingEntryKind) {
      const kind = pendingEntryKind;
      pendingEntryKind = "";
      openEntry(kind);
    }
    if (pendingLikeId) {
      const id = pendingLikeId;
      pendingLikeId = "";
      const { activity } = await apiRequest("/api/activities/action", { method: "POST", body: JSON.stringify({ id, action: "like" }) });
      replaceActivity(activity);
      renderTimeline();
    }
  } catch (error) {
    currentUser = null;
    tripDataLoaded = false;
    updateAccountControl();
    $("#sign-in-hint").textContent = error.message;
  }
});
$("#member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const saveButton = form.querySelector("button[type=\"submit\"]");
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    const isEmpty = !values.iban.trim();
    const { member_iban: iban } = await apiRequest(isEmpty ? "/api/member-iban/clear" : "/api/member-iban", {
      method: "POST",
      body: JSON.stringify(isEmpty ? {} : values)
    });
    memberIbans[currentUser.name] = iban;
    $("#member-dialog").close();
    showToast(iban ? "IBAN updated" : "IBAN cleared");
  } catch (error) {
    $("#member-iban-hint").textContent = error.message;
    $("#member-iban-hint").classList.add("form-hint-error");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save changes";
  }
});
$("#sign-out-button").addEventListener("click", async () => {
  try { await apiRequest("/api/logout", { method: "POST", body: "{}" }); }
  catch (error) { showToast(error.message); }
  if ($("#sign-in-dialog").open) $("#sign-in-dialog").close();
  currentUser = null;
  tripDataLoaded = false;
  records = [];
  memberIbans = {};
  updateAccountControl();
});
setView();
initLandingMotion();
if (previewMode) {
  document.body.classList.add("preview-mode");
  const notice = document.createElement("div");
  notice.className = "preview-notice";
  notice.textContent = "Read-only preview · changes are not saved";
  document.body.prepend(notice);
  currentUser = { name: "Felix", role: "admin" };
  records = [
    { type: "stay", id: "stay-preview", title: "Au Vieux Pin", details: "A bastide for 2 to 6 people", paid_by: "Felix", amount: "909", status: "paid", created_by: "Felix" },
    { type: "activity", id: "activity-preview", date: "2026-10-17", time: "10:30", title: "Domaine Overnoy", details: "Requested; awaiting confirmation", location: "Domaine Overnoy", status: "pending", created_by: "Felix", likes: ["Kai", "Giulio"] },
    { type: "activity", id: "activity-preview-lunch", date: "2026-10-17", time: "12:30", title: "Lunch in Arbois", details: "A relaxed stop between vineyard visits.", location: "Arbois", status: "pending", created_by: "Giulio", likes: ["Lucia"] },
    { type: "activity", id: "activity-preview-walk", date: "2026-10-18", time: "10:00", title: "Explore Château-Chalon", details: "A village walk with views across the vineyards.", location: "Château-Chalon", status: "done", created_by: "Lucia", likes: ["Kai", "Giulio", "Felix"] }
  ];
  tripDataLoaded = true;
  updateAccountControl();
  render();
} else {
apiRequest("/api/session").then(async ({ user, registered_members: registeredMembersFromServer }) => {
  registeredMembers = registeredMembersFromServer || [];
  currentUser = user;
  if (currentUser) await loadTripData();
  else updateAccountControl();
}).catch(() => {
  currentUser = null;
  tripDataLoaded = false;
  updateAccountControl();
  showToast("Shared trip server is unavailable");
});
window.setInterval(() => {
  if (!currentUser || previewMode) return;
  refreshActivities().catch(() => {});
  refreshEntries().catch(() => {});
}, 5000);
}
