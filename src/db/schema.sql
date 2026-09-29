-- Drop Shelf v1 schema (SQLite)

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id   INTEGER PRIMARY KEY,
  username           TEXT,
  first_name         TEXT,
  referral_code      TEXT NOT NULL UNIQUE,
  referrer_id        INTEGER REFERENCES users(telegram_user_id),
  alert_opt_in       INTEGER NOT NULL DEFAULT 0,
  referral_reward_granted_at INTEGER,
  created_at         INTEGER NOT NULL
);

-- Books and bundles. A bundle lists the book ids it unlocks in bundle_items (JSON array).
CREATE TABLE IF NOT EXISTS books (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL DEFAULT 'book' CHECK (kind IN ('book', 'bundle')),
  title              TEXT NOT NULL,
  short_title        TEXT NOT NULL,           -- invoice titles are capped at 32 chars
  pitch              TEXT NOT NULL,           -- one-liner for /shelf
  description        TEXT NOT NULL,           -- invoice description (<= 255 chars)
  audience           TEXT,
  launch_price_stars INTEGER NOT NULL,
  full_price_stars   INTEGER NOT NULL,
  launch_ends_at     INTEGER,                 -- NULL: launch price open-ended; set when the drop goes live
  is_current_drop    INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  bundle_items       TEXT,
  reader_group_url   TEXT,
  created_at         INTEGER NOT NULL
);

-- One row per purchase (the per-user "purchases array").
-- charge_id holds telegram_payment_charge_id (Stars), the tx hash (TON) or a synthetic id (referral reward).
CREATE TABLE IF NOT EXISTS purchases (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id   INTEGER NOT NULL REFERENCES users(telegram_user_id),
  book_id            INTEGER NOT NULL REFERENCES books(id),
  method             TEXT NOT NULL CHECK (method IN ('stars', 'ton', 'referral')),
  stars_paid         INTEGER NOT NULL DEFAULT 0,
  ton_paid_nano      TEXT,
  charge_id          TEXT NOT NULL UNIQUE,
  provider_charge_id TEXT,
  created_at         INTEGER NOT NULL,
  refunded_at        INTEGER
);
CREATE INDEX IF NOT EXISTS purchases_user ON purchases(telegram_user_id);

-- Stars invoices we issued; pre_checkout_query is validated against these.
CREATE TABLE IF NOT EXISTS invoices (
  id                 TEXT PRIMARY KEY,
  telegram_user_id   INTEGER NOT NULL,
  book_id            INTEGER NOT NULL,
  stars_amount       INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  paid_at            INTEGER
);

-- TON web orders. The order id is the transfer comment.
CREATE TABLE IF NOT EXISTS ton_orders (
  id                 TEXT PRIMARY KEY,
  access_token       TEXT NOT NULL,
  book_id            INTEGER NOT NULL REFERENCES books(id),
  amount_nano        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'refunded')),
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  tx_hash            TEXT UNIQUE,
  sender             TEXT,
  paid_nano          TEXT,
  paid_at            INTEGER,
  claim_token        TEXT UNIQUE,
  claimed_by         INTEGER
);

CREATE TABLE IF NOT EXISTS ton_seen_tx (
  hash               TEXT PRIMARY KEY,
  lt                 TEXT NOT NULL,
  matched_order_id   TEXT,
  note               TEXT,
  seen_at            INTEGER NOT NULL
);

-- Telegram file_id cache for files that are identical for every user (EPUB, samples, covers).
CREATE TABLE IF NOT EXISTS file_cache (
  path               TEXT PRIMARY KEY,
  mtime_ms           INTEGER NOT NULL,
  file_id            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id   INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  topic_id           INTEGER,
  created_at         INTEGER NOT NULL,
  closed_at          INTEGER
);

-- Maps messages posted in the support chat back to their ticket (for reply-based threads).
CREATE TABLE IF NOT EXISTS support_messages (
  support_message_id INTEGER PRIMARY KEY,
  ticket_id          INTEGER NOT NULL REFERENCES support_tickets(id)
);

-- Deep-link and funnel events (/start payloads, samples, downloads) for metrics.
CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id   INTEGER,
  type               TEXT NOT NULL,
  data               TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type ON events(type, telegram_user_id);

CREATE TABLE IF NOT EXISTS kv (
  key                TEXT PRIMARY KEY,
  value              TEXT NOT NULL
);
