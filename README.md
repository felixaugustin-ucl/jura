# Jura trip home

The site uses Ruby's standard-library WEBrick server. Trip details are hidden until a member signs in. Shared expenses, payments, activity proposals, likes, confirmations, and member IBANs are stored in `.jura-shared.json` on the server.

## Run locally

1. Copy `.env.example` to `.env` and set a private `FELIX_ADMIN_PASSWORD`.
2. Start the server with `ruby server.rb`.
3. Open `http://127.0.0.1:8000`.

On first sign-in, each member selects their name and registers an IBAN for payments. Later sign-ins require only the name; Felix also enters the private admin password. The IBAN is payment information, not a strong secret or identity proof. Only Felix can confirm or reopen proposals; other signed-in members can like proposals and manage their own entries and activities.

Paid shared expenses are divided equally among all four members. For example, a €100 dinner adds a €25 share to each person and gives the payer €75 net credit. Members can add an expense to compensate or pay directly; preferably, they settle the remaining balance at the very end. Paid transfers then reduce each person's remainder; the Accounts view shows who should pay whom and the recipient IBAN.

The sessions are held in server memory and expire when the server restarts. Shared trip data is stored on disk. Keep `.env` and `.jura-shared.json` private and out of version control.

## Sharing with the group

Everyone must open the same server URL to share trip data. For a private local network, start with `BIND_ADDRESS=0.0.0.0 ruby server.rb` and share the host's LAN address. Do not expose this server directly to the public internet: put it behind HTTPS and a trusted reverse proxy, then set `COOKIE_SECURE=true` in `.env`. Name plus IBAN is convenient for this private trip group, not public identity verification.
