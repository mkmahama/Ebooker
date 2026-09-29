# Drop Shelf v1

A Telegram-native ebook shop for AI and workflow-automation guides. Three surfaces:

- **Bot (@YourShelfBot)**: free chapter, shelf, Telegram Stars (`XTR`) checkout, instant delivery, re-download library, referrals, payment support.
- **Web page**: TON checkout through TON Connect, about 12% cheaper, with signed, expiring download links.
- **Channel (@YourShelf)**: launch posts with deep links into the bot (and the web page).

The bot is Stars-only: it never shows TON prices or links to the web checkout (a test enforces this). TON is promoted from the channel and the web.

## Quick start

```bash
cp .env.example .env         # fill in BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET, DOWNLOAD_SECRET, TON_WALLET_ADDRESS...
npm install
npm run seed                 # creates the database and the three drops + bundle
npm start                    # web server, webhook/polling bot, TON watcher
npm test                     # 30 tests, no network needed
```

Requires Node 22.13+ (uses the built-in `node:sqlite`). Only runtime dependency: `pdf-lib` (buyer-id stamping).
Enable Stars payments for the bot in @BotFather. For local development set `BOT_MODE=polling`.

## Bot commands

Exactly seven commands are registered; everything else is inline buttons.

| Command | Behaviour |
|---|---|
| `/start` | Welcome + "Get a free chapter", "Browse the shelf", "My library". Deep-link payloads: `sample`, `sample_<source>`, `shelf`, `library`, `buy_<slug>`, `book_<slug>`, `ref_<code>`, `claim_<token>` (all logged to `events`) |
| `/shelf` | Active books, current drop first: cover, pitch, launch/full price, **Buy** and **Free chapter** |
| `/sample` | Sends the lead magnet (AI daily brief guide PDF + n8n JSON) and opts into drop alerts |
| `/library` | Owned books with EPUB and PDF re-download buttons |
| `/invite` | Personal referral link and "2 of 3 referrals to your free book" |
| `/help` | FAQ, refund policy, contact button |
| `/paysupport` | Opens a support ticket: a forum topic (or reply thread) in the staff group; messages relay both ways |

## Payments

**Stars.** `sendInvoice` with `currency: "XTR"` and an empty `provider_token`; the invoice payload is an id in the `invoices` table.
`pre_checkout_query` is answered from local DB reads only (checks user, amount, currency, invoice age, availability, not already owned) and, in webhook mode, before the HTTP response is returned.
Files are delivered only on `successful_payment`; `telegram_payment_charge_id` is stored as `purchases.charge_id` (unique, so duplicate updates are no-ops).
Refunds: `npm run admin -- refund <charge_id>` calls `refundStarPayment` and sends the refund confirmation. `refunded_payment` updates are recorded too.

**TON.** `POST /api/orders` creates an order `DS-XXXXXXXXXX` and returns the TON Connect message: receiving address, amount in nanotons, and a `payload` BOC holding the order id as a text comment (hand-built; tests check it byte for byte against `@ton/core`).
The watcher polls toncenter `getTransactions` for the wallet and marks an order paid when an incoming transfer has that exact comment and at least the amount (underpayments and duplicates are logged, not honoured; late payments on expired orders are honoured).
The page polls `GET /api/orders/:id?token=...` (the access token never goes on-chain) and then shows HMAC-signed links `/download/:order/:book/:format?exp&sig` that expire after `DOWNLOAD_TTL_HOURS`. A **Claim in Telegram** deep link adds the web purchase (with its tx hash) to the buyer's `/library`.

TON prices are derived from the current Stars price: `stars × STAR_USD × (1 − TON_DISCOUNT) ÷ TON/USD`, rounded up to 0.01 TON. `TON_PRICING_MODE=fixed` uses `TON_USD_RATE`; `usd_peg` refreshes the rate from `TON_RATE_URL` every `TON_RATE_REFRESH_HOURS`. The amount is locked when an order is created.

## Data

Per user (`users` + `purchases`; `store.getUserProfile(id)` returns it in this shape):

```json
{ "telegram_user_id": 123, "referral_code": "K7PQ2M9X", "referrer_id": 456, "alert_opt_in": true,
  "purchases": [{ "book_id": 1, "method": "stars", "stars_paid": 300, "ton_paid_nano": null,
                  "charge_id": "stxABC...", "created_at": 1790000000000, "refunded_at": null }] }
```

`charge_id` is the Stars charge id, the TON tx hash, or `referral:<user>` for a referral reward. Other tables: `books`, `invoices`, `ton_orders`, `ton_seen_tx`, `support_tickets`, `support_messages`, `file_cache`, `events`, `kv` (see `src/db/schema.sql`).

## Catalog (seeded)

| Slug | Book | Launch / full |
|---|---|---|
| `ai-control-center` (current drop) | Telegram as Your AI Control Center | 300 / 450 Stars |
| `automate-channel-ai` | Automate Your Telegram Channel with AI | 200 / 300 Stars |
| `first-ai-workflow-weekend` | Zapier vs Make vs n8n: Ship Your First AI Workflow in a Weekend | 100 / 150 Stars |
| `drop-shelf-bundle` | All three | 600 Stars |

The launch price applies until `launch_ends_at`. It stays open-ended until you run `launch`, which starts the 48-hour window. Add the actual EPUB/PDF files under `storage/` (see `storage/README.md`).

## Operating the shop

```bash
npm run admin -- books                        # prices and launch windows
npm run admin -- launch automate-channel-ai   # make it the current drop, start 48h launch price, alert subscribers, post to channel
npm run admin -- end-launch ai-control-center # switch to full price now
npm run admin -- set ai-control-center reader_group_url https://t.me/+invite
npm run admin -- refund <charge_id>
npm run admin -- user <telegram_user_id>
npm run admin -- orders
npm run admin -- stats                        # sample->purchase rate, Stars vs TON split, referral share, refund rate, opt-ins
```

The free chapter PDF is generated from `content/samples/lead-magnet/ai-daily-brief.md` with `node scripts/build-sample-pdf.js`.

## Layout

```
src/index.js            entry: web server, webhook/polling, TON watcher
src/app.js              service wiring (shared with the admin CLI)
src/bot/bot.js          commands, Stars payments, delivery, referrals, support threads, drop alerts
src/bot/messages.js     all user-facing copy (receipt, delivery, drop alert, refund, referral reward...)
src/store.js            data access
src/pricing.js          launch window, TON pricing
src/ton/                comment BOC, orders, wallet watcher
src/web/                HTTP server, signed links, checkout page (public/)
src/files/storage.js    book files, samples, PDF stamping
scripts/                seed, admin CLI, sample PDF builder
content/samples/        the free chapter (guide PDF + n8n workflow JSON)
```

## Not in v1

Emailing download links to web buyers, paid-media chapter previews in the channel, and the proof-of-purchase collectible (a `hooks.onPurchase` hook point exists in `Bot`).
