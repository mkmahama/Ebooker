# Drop Shelf v1

A Telegram-native ebook shop for AI and workflow-automation guides.

- **Telegram bot** (@YourShelfBot): free sample, shelf, library, referrals, support. Sells digital goods **only in Telegram Stars (`XTR`)**.
- **Web checkout**: the same books for **TON** via TON Connect, about 12% cheaper (no app-store cut).
- **Channel**: drop announcements with deep links into the bot.

No npm dependencies. Everything runs on Node 22's built-ins (`node:sqlite`, `node:http`, `fetch`, `crypto`); the browser loads TON Connect UI 2.4.4 from unpkg.

## Quick start

```bash
cp .env.example .env        # fill in BOT_TOKEN, LINK_SECRET, TON_RECEIVER_ADDRESS, ...
npm run placeholders        # placeholder EPUB/PDF/sample files so every flow works today
npm test                    # 41 tests
npm start                   # web server + bot + TON wallet watcher in one process
```

Requires **Node 22.5+**. For local development use `BOT_MODE=polling` and `TON_NETWORK=testnet`.

### One-time Telegram setup

1. Create the bot with @BotFather and put the token in `BOT_TOKEN`. Stars payments need no provider token.
2. Create a **private support group**, add the bot, and put the group id in `SUPPORT_CHAT_ID`. `/paysupport` threads land there. Turn on **Topics** in the group and give the bot the *Manage topics* admin right, and every ticket gets its own forum topic. Without topics, tickets fall back to reply threads.
3. Create the channel (`CHANNEL_ID`) and make the bot an admin that can post.
4. Commands register themselves on startup (`setMyCommands`), exactly the seven below.

### Production

- Serve over HTTPS at `PUBLIC_URL` (TON Connect and Telegram webhooks both require it), e.g. behind Caddy or nginx.
- Set `BOT_MODE=webhook`. The app calls `setWebhook` to `PUBLIC_URL/tg/webhook` with `WEBHOOK_SECRET` and verifies the secret header on every update. If Telegram is unreachable at boot, the web checkout keeps running and the webhook retries every 60 s.
- Set `TON_NETWORK=mainnet` only after a full testnet purchase. A `TONCENTER_API_KEY` raises the watcher's rate limit.
- Back up `data/dropshelf.db` (SQLite, WAL mode).

## How it maps to the spec

### Boundaries
| Surface | Pays with | Notes |
| --- | --- | --- |
| Bot | Stars only | No TON prices, wallets or web-checkout links anywhere in bot messages or buttons. A test scans every bot output to enforce this. |
| Web page | TON only | Links to the bot for Stars buyers. |
| Channel posts | Stars only | Posted by the bot, so they follow the bot rule: Stars prices and deep links into the bot, no TON prices or web-checkout links. Promote the web page from your own site or socials. |

### Bot commands (exactly 7; everything else is inline buttons)
| Command | Behavior |
| --- | --- |
| `/start` | Welcome + **Get a free chapter / Browse the shelf / My library**. Deep links: `sample`, `sample_<book>`, `buy_<book>`, `ref_<CODE>`, `claim_<CODE>`, `shelf`, `library`. The first payload is stored as the user's source. |
| `/shelf` | Live books, current drop first, cover (if `cover.jpg` exists), pitch, price (launch countdown), **Buy** and **Free chapter**. Owned books show **Download**. |
| `/sample` | Sends the AI daily brief chapter PDF + n8n workflow JSON and opts the user into drop alerts. |
| `/library` | Every owned book with EPUB and PDF re-download buttons (ownership checked on every tap). |
| `/invite` | Personal link `t.me/<bot>?start=ref_<CODE>` and progress, e.g. "2 of 3 referrals to your free book". A referral counts once the invited user buys. |
| `/help` | FAQ, refund policy, Contact button, alert toggle. |
| `/paysupport` | Opens a ticket (one open per user) in its own forum topic of the support group, headed by the user's recent charge ids. Messages relay both ways; agents just write in the topic (or reply to a relayed message when topics are off). `!close` or the user's *Close ticket* button closes the ticket and its topic. |

### Stars checkout
1. **Buy** → `sendInvoice` with `currency: "XTR"`, a 32-char-safe invoice title and payload `v1|<book>|<price>|<issued_at>`.
2. `pre_checkout_query` is answered from local SQLite in milliseconds. It rejects tampered amounts, non-XTR currency, hidden books, already-owned books, and stale prices (an invoice keeps its quoted price for one hour, so a launch-price invoice paid just after the window closes still works).
3. Files are sent **only** on `successful_payment`. The purchase row (with `telegram_payment_charge_id`) is written first, then files go out, then it is marked delivered. If delivery fails, the webhook answers 500 (the poller holds its offset) so Telegram redelivers the update; the retry resends only undelivered files and never double-records. If two parallel invoices are both paid, the second is refunded automatically with `refundStarPayment`.
4. Files upload once; later deliveries reuse Telegram's `file_id`.

Refund manually: `npm run refund -- <charge_id | purchase_id>`.

### TON checkout
1. `POST /api/orders` creates order `DS-XXXXXXXX` (8-char code, 30-min TTL) and returns a TON Connect transaction: receiver, amount in nanotons, and a BOC-encoded **text comment containing the order id**. The encoder is byte-identical to `@ton/core` (tested against a known vector).
2. The watcher polls toncenter v2 `getTransactions` every 10 s (paging back until it reaches seen transactions), matches the comment and requires `amount ≥ price`. It records the transaction hash; overpayments are accepted, underpayments are flagged, and late payments within 24 h of expiry are still credited. Every sale and anomaly is posted to the support group.
3. The page polls `GET /api/orders/:id` with a **private view key** (the order id is public on-chain, so it alone never unlocks files). Once paid it shows **signed, expiring** EPUB/PDF links (HMAC-SHA256, `LINK_TTL_MINUTES`) and an optional **Add to my Telegram library** deep link (`claim_<CODE>`, single use).
4. Buyers without TON Connect can pay manually with the displayed amount, address and comment.

### Data model (`src/db.js`)
- `users`: `telegram_user_id` (PK), `referral_code`, `referrer_id`, `alert_opt_in`, `referral_rewarded`, `first_source`.
- `purchases`: one row per owned book: `book_id`, `method` (stars / ton / referral / gift), `stars_paid` or `ton_paid_nano`, `charge_id` or `tx_hash`, `created_at`, `refunded_at`. `db.getUserWithPurchases(id)` returns the user with this **purchases array**. A normalized table (instead of a JSON column) lets SQLite enforce one active copy per book and unique charge ids / tx hashes.
- `ton_orders`, `ton_seen_tx`, `support_tickets`, `support_relay`, `file_cache`, `books`.

### Catalog (seeded on first start)
| # | Book id | Launch | Full | Web (TON) at full |
| --- | --- | --- | --- | --- |
| 1 | `ai-control-center`: Telegram as Your AI Control Center | 300 ⭐ | 450 ⭐ | 1.98 |
| 2 | `ai-channel-automation`: Automate Your Telegram Channel with AI | 200 ⭐ | 300 ⭐ | 1.32 |
| 3 | `first-ai-workflow`: Zapier vs Make vs n8n: Ship Your First AI Workflow in a Weekend | 100 ⭐ | 150 ⭐ | 0.66 |

TON prices = Stars × `TON_PER_STAR` × (1 − `TON_DISCOUNT`), rounded up to 0.01 TON. **Update `TON_PER_STAR` when the TON price moves.** Launch prices apply only inside a launch window you start with `npm run drop`.

## Running drops

```bash
npm run drop -- list                                   # prices, status, missing files
npm run drop -- launch ai-control-center --hours 48 --announce   # launch price for 48h, feature it, post to channel, alert subscribers
npm run drop -- announce ai-channel-automation --channel-only
npm run drop -- hide first-ai-workflow                 # take off the shelf
```

Alerts go only to opted-in users, skip people who already own the book, stay under Telegram's rate limits, and unsubscribe anyone who blocked the bot.

## Replacing the placeholder content

```
content/sample/daily-brief-chapter.pdf       free chapter (lead magnet)
content/sample/daily-brief-workflow.json     n8n workflow (starter; export your tested version over it)
content/books/<book-id>/book.epub
content/books/<book-id>/book.pdf
content/books/<book-id>/sample.pdf           optional per-book free chapter
content/books/<book-id>/cover.jpg            optional; shown in /shelf and channel posts
public/icon.png                              180x180 icon for TON Connect wallets
```

Replacing a file is enough: the bot notices the new modification time and re-uploads it. `npm run placeholders` never overwrites existing files (add `--force` to regenerate).

## Before launch checklist
- [ ] Real EPUB/PDF files and the tested daily-brief workflow in `content/`
- [ ] Rewrite `REFUND_POLICY` and the FAQ in `src/bot/bot.js` to match your terms
- [ ] One full Stars purchase and one refund with a real account
- [ ] One full TON purchase on **testnet**, then switch to mainnet
- [ ] Confirm you can legally receive Stars/TON income where you live
