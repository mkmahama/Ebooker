import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id INTEGER PRIMARY KEY,
  username         TEXT,
  first_name       TEXT,
  referral_code    TEXT NOT NULL UNIQUE,
  referrer_id      INTEGER REFERENCES users(telegram_user_id),
  referral_rewarded INTEGER NOT NULL DEFAULT 0,
  alert_opt_in     INTEGER NOT NULL DEFAULT 0,
  first_source     TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id               TEXT PRIMARY KEY,
  drop_number      INTEGER NOT NULL,
  title            TEXT NOT NULL,
  invoice_title    TEXT NOT NULL,            -- Bot API invoice titles max 32 chars
  pitch            TEXT NOT NULL,
  description      TEXT NOT NULL,            -- invoice description, max 255 chars
  launch_stars     INTEGER NOT NULL,
  full_stars       INTEGER NOT NULL,
  launch_ends_at   INTEGER,                  -- unix seconds; launch price applies until then
  status           TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','hidden')),
  featured         INTEGER NOT NULL DEFAULT 0,
  released_at      INTEGER NOT NULL
);

-- One row per owned book. The users' "purchases array" is this table grouped by user.
CREATE TABLE IF NOT EXISTS purchases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER REFERENCES users(telegram_user_id),
  book_id          TEXT NOT NULL REFERENCES books(id),
  method           TEXT NOT NULL CHECK (method IN ('stars','ton','referral','gift')),
  stars_paid       INTEGER,
  ton_paid_nano    TEXT,
  charge_id        TEXT UNIQUE,              -- telegram_payment_charge_id (Stars refunds)
  tx_hash          TEXT UNIQUE,              -- TON transaction hash
  order_id         TEXT,
  refunded_at      INTEGER,
  delivered_at     INTEGER,                  -- set once the files reached the buyer in Telegram
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_user ON purchases(telegram_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchases_one_active_copy
  ON purchases(telegram_user_id, book_id) WHERE refunded_at IS NULL AND telegram_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ton_orders (
  id               TEXT PRIMARY KEY,         -- also the transfer comment, e.g. DS-7K2QH9XA
  secret_hash      TEXT NOT NULL,            -- buyer's view key (the id is public on-chain)
  claim_code       TEXT NOT NULL UNIQUE,     -- deep link to add the book to a Telegram library
  book_id          TEXT NOT NULL REFERENCES books(id),
  amount_nano      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','paid','underpaid','expired')),
  tx_hash          TEXT UNIQUE,
  received_nano    TEXT,
  claimed_by       INTEGER REFERENCES users(telegram_user_id),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  paid_at          INTEGER
);

CREATE TABLE IF NOT EXISTS ton_seen_tx (
  hash             TEXT PRIMARY KEY,
  lt               TEXT NOT NULL,
  seen_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL REFERENCES users(telegram_user_id),
  status           TEXT NOT NULL CHECK (status IN ('open','closed')),
  thread_id        INTEGER,                  -- forum topic in SUPPORT_CHAT_ID, when topics are enabled
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER
);
CREATE TABLE IF NOT EXISTS support_relay (
  support_message_id INTEGER PRIMARY KEY,    -- message id in SUPPORT_CHAT_ID
  ticket_id          INTEGER NOT NULL REFERENCES support_tickets(id)
);

CREATE TABLE IF NOT EXISTS file_cache (
  path             TEXT PRIMARY KEY,
  mtime_ms         INTEGER NOT NULL,
  file_id          TEXT NOT NULL
);
`;

// Seed catalog: the three AI-automation drops.
export const SEED_BOOKS = [
  {
    id: 'ai-control-center',
    drop_number: 1,
    title: 'Telegram as Your AI Control Center',
    invoice_title: 'AI Control Center',
    pitch: '8–10 tested n8n workflows you run from a Telegram bot: daily briefs, inbox triage, approvals.',
    description:
      'Ebook (EPUB + PDF) with 8–10 tested n8n workflows run from a Telegram bot: AI daily brief, inbox triage, content drafts with approve/reject, invoice extraction, lead capture. Includes importable JSON files.',
    launch_stars: 300,
    full_stars: 450,
    featured: 1,
  },
  {
    id: 'ai-channel-automation',
    drop_number: 2,
    title: 'Automate Your Telegram Channel with AI',
    invoice_title: 'AI Channel Automation',
    pitch: 'An AI content pipeline for your channel: drafts, scheduling, repurposing and moderation.',
    description:
      'Ebook (EPUB + PDF) for channel owners: an AI content pipeline, scheduled posting, repurposing, comment moderation and Stars sales alerts, built with n8n.',
    launch_stars: 200,
    full_stars: 300,
    featured: 0,
  },
  {
    id: 'first-ai-workflow',
    drop_number: 3,
    title: 'Zapier vs Make vs n8n: Ship Your First AI Workflow in a Weekend',
    invoice_title: 'Ship Your First AI Workflow',
    pitch: 'Pick the right tool and build one AI workflow three ways, in a weekend.',
    description:
      'Beginner ebook (EPUB + PDF): how to choose between Zapier, Make and n8n, what each costs, and one AI workflow built three ways.',
    launch_stars: 100,
    full_stars: 150,
    featured: 0,
  },
];

const now = () => Math.floor(Date.now() / 1000);
const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

export function randomCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += BASE32[b % BASE32.length];
  return out;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  seedBooks(db);
  return wrap(db);
}

/** Additive migrations for databases created by an earlier version. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(support_tickets)').all().map((c) => c.name);
  if (!cols.includes('thread_id')) db.exec('ALTER TABLE support_tickets ADD COLUMN thread_id INTEGER');
}

function seedBooks(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO books
    (id, drop_number, title, invoice_title, pitch, description, launch_stars, full_stars, featured, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const b of SEED_BOOKS) {
    if (b.invoice_title.length > 32) throw new Error(`invoice_title too long: ${b.id}`);
    if (b.description.length > 255) throw new Error(`description too long: ${b.id}`);
    insert.run(b.id, b.drop_number, b.title, b.invoice_title, b.pitch, b.description,
      b.launch_stars, b.full_stars, b.featured, now());
  }
}

function wrap(db) {
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const api = {
    raw: db,
    tx,
    close: () => db.close(),

    // ---------- users ----------
    getUser(id) {
      return q('SELECT * FROM users WHERE telegram_user_id = ?').get(id) || null;
    },
    /** Spec shape: the user row plus its purchases array. */
    getUserWithPurchases(id) {
      const user = api.getUser(id);
      if (!user) return null;
      return { ...user, alert_opt_in: !!user.alert_opt_in, purchases: api.listPurchases(id) };
    },
    getUserByReferralCode(code) {
      return q('SELECT * FROM users WHERE referral_code = ?').get(code) || null;
    },
    /** Create the user if new. Returns { user, created }. */
    upsertUser({ id, username, first_name }, source = null) {
      const existing = api.getUser(id);
      if (existing) {
        q('UPDATE users SET username = ?, first_name = ? WHERE telegram_user_id = ?')
          .run(username ?? null, first_name ?? null, id);
        return { user: api.getUser(id), created: false };
      }
      for (let i = 0; i < 5; i++) {
        try {
          q(`INSERT INTO users (telegram_user_id, username, first_name, referral_code, first_source, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`).run(id, username ?? null, first_name ?? null, randomCode(8), source, now());
          return { user: api.getUser(id), created: true };
        } catch (e) {
          if (!String(e.message).includes('referral_code')) throw e; // retry only on code collision
        }
      }
      throw new Error('could not allocate referral code');
    },
    setReferrer(userId, referrerId) {
      q('UPDATE users SET referrer_id = ? WHERE telegram_user_id = ? AND referrer_id IS NULL')
        .run(referrerId, userId);
    },
    setAlertOptIn(userId, on) {
      q('UPDATE users SET alert_opt_in = ? WHERE telegram_user_id = ?').run(on ? 1 : 0, userId);
    },
    listAlertSubscribers() {
      return q('SELECT telegram_user_id FROM users WHERE alert_opt_in = 1').all().map((r) => r.telegram_user_id);
    },
    /** Referred users who own at least one paid (Stars or TON) book. */
    countQualifiedReferrals(referrerId) {
      return q(`SELECT COUNT(DISTINCT u.telegram_user_id) AS n FROM users u
                JOIN purchases p ON p.telegram_user_id = u.telegram_user_id
                WHERE u.referrer_id = ? AND p.method IN ('stars','ton') AND p.refunded_at IS NULL`)
        .get(referrerId).n;
    },
    countReferredUsers(referrerId) {
      return q('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?').get(referrerId).n;
    },
    markReferralRewarded(userId) {
      return q('UPDATE users SET referral_rewarded = 1 WHERE telegram_user_id = ? AND referral_rewarded = 0')
        .run(userId).changes === 1;
    },

    // ---------- books ----------
    getBook(id) {
      return q('SELECT * FROM books WHERE id = ?').get(id) || null;
    },
    /** Live books, current drop first (featured, then newest release, then drop order). */
    listLiveBooks() {
      return q(`SELECT * FROM books WHERE status = 'live'
                ORDER BY featured DESC, released_at DESC, drop_number ASC`).all();
    },
    startLaunch(bookId, hours) {
      tx(() => {
        q('UPDATE books SET featured = 0').run();
        q(`UPDATE books SET featured = 1, status = 'live', released_at = ?, launch_ends_at = ? WHERE id = ?`)
          .run(now(), now() + Math.round(hours * 3600), bookId);
      });
    },
    setBookStatus(bookId, status) {
      q('UPDATE books SET status = ? WHERE id = ?').run(status, bookId);
    },

    // ---------- purchases ----------
    listPurchases(userId) {
      return q(`SELECT p.*, b.title FROM purchases p JOIN books b ON b.id = p.book_id
                WHERE p.telegram_user_id = ? AND p.refunded_at IS NULL ORDER BY p.created_at DESC`).all(userId);
    },
    ownsBook(userId, bookId) {
      return !!q(`SELECT 1 FROM purchases WHERE telegram_user_id = ? AND book_id = ? AND refunded_at IS NULL`)
        .get(userId, bookId);
    },
    getPurchaseByCharge(chargeId) {
      return q('SELECT * FROM purchases WHERE charge_id = ?').get(chargeId) || null;
    },
    getPurchase(id) {
      return q('SELECT * FROM purchases WHERE id = ?').get(id) || null;
    },
    /**
     * Record a Stars purchase. Idempotent on charge_id: a repeated update returns the first row.
     * If the user somehow already owns the book (double payment), the row is still stored
     * (without the ownership index clash) so it can be refunded.
     */
    recordStarsPurchase({ userId, bookId, stars, chargeId }) {
      const prior = api.getPurchaseByCharge(chargeId);
      if (prior) return { purchase: prior, duplicate: true, alreadyOwned: false };
      const alreadyOwned = api.ownsBook(userId, bookId);
      const info = q(`INSERT INTO purchases (telegram_user_id, book_id, method, stars_paid, charge_id, refunded_at, created_at)
                      VALUES (?, ?, 'stars', ?, ?, ?, ?)`)
        // A second paid copy (two invoices paid in parallel) is stored as refunded; the bot refunds it.
        .run(userId, bookId, stars, chargeId, alreadyOwned ? now() : null, now());
      return { purchase: api.getPurchase(Number(info.lastInsertRowid)), duplicate: false, alreadyOwned };
    },
    grantBook({ userId, bookId, method }) {
      if (api.ownsBook(userId, bookId)) return false;
      q(`INSERT INTO purchases (telegram_user_id, book_id, method, created_at) VALUES (?, ?, ?, ?)`)
        .run(userId, bookId, method, now());
      return true;
    },
    markRefunded(purchaseId) {
      q('UPDATE purchases SET refunded_at = ? WHERE id = ?').run(now(), purchaseId);
    },
    markDelivered(purchaseId) {
      q('UPDATE purchases SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(now(), purchaseId);
    },

    // ---------- TON orders ----------
    createTonOrder({ bookId, amountNano, ttlMinutes }) {
      const secret = crypto.randomBytes(18).toString('base64url');
      for (let i = 0; i < 5; i++) {
        const id = `DS-${randomCode(8)}`;
        try {
          q(`INSERT INTO ton_orders (id, secret_hash, claim_code, book_id, amount_nano, status, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(id, sha256(secret), randomCode(12), bookId, String(amountNano), now(), now() + ttlMinutes * 60);
          return { order: api.getTonOrder(id), secret };
        } catch (e) {
          if (!String(e.message).includes('UNIQUE')) throw e;
        }
      }
      throw new Error('could not allocate order id');
    },
    getTonOrder(id) {
      return q('SELECT * FROM ton_orders WHERE id = ?').get(id) || null;
    },
    getTonOrderByClaim(code) {
      return q('SELECT * FROM ton_orders WHERE claim_code = ?').get(code) || null;
    },
    checkOrderSecret(order, secret) {
      if (!order || !secret) return false;
      const a = Buffer.from(order.secret_hash);
      const b = Buffer.from(sha256(secret));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
    /** Orders a transfer can still settle: pending, or expired recently (late payers still get the book). */
    openOrderIds(graceSeconds = 24 * 3600) {
      return q(`SELECT id FROM ton_orders WHERE status = 'pending'
                OR (status = 'expired' AND expires_at > ?)`).all(now() - graceSeconds).map((r) => r.id);
    },
    expireOrders() {
      return q(`UPDATE ton_orders SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`).run(now()).changes;
    },
    settleTonOrder({ orderId, txHash, receivedNano, lt }) {
      return tx(() => {
        q('INSERT OR IGNORE INTO ton_seen_tx (hash, lt, seen_at) VALUES (?, ?, ?)').run(txHash, String(lt), now());
        const order = api.getTonOrder(orderId);
        if (!order || order.status === 'paid' || order.status === 'underpaid') return { changed: false, order };
        const enough = BigInt(receivedNano) >= BigInt(order.amount_nano);
        q(`UPDATE ton_orders SET status = ?, tx_hash = ?, received_nano = ?, paid_at = ? WHERE id = ?`)
          .run(enough ? 'paid' : 'underpaid', txHash, String(receivedNano), now(), orderId);
        if (enough) {
          q(`INSERT INTO purchases (telegram_user_id, book_id, method, ton_paid_nano, tx_hash, order_id, created_at)
             VALUES (NULL, ?, 'ton', ?, ?, ?, ?)`).run(order.book_id, String(receivedNano), txHash, orderId, now());
        }
        return { changed: true, order: api.getTonOrder(orderId) };
      });
    },
    markTxSeen(hash, lt) {
      q('INSERT OR IGNORE INTO ton_seen_tx (hash, lt, seen_at) VALUES (?, ?, ?)').run(hash, String(lt), now());
    },
    isTxSeen(hash) {
      return !!q('SELECT 1 FROM ton_seen_tx WHERE hash = ?').get(hash);
    },
    /** Link a paid web order to a Telegram user's library. */
    claimTonOrder(claimCode, userId) {
      return tx(() => {
        const order = api.getTonOrderByClaim(claimCode);
        if (!order) return { ok: false, reason: 'not_found' };
        if (order.status !== 'paid') return { ok: false, reason: 'not_paid', order };
        if (order.claimed_by && order.claimed_by !== userId) return { ok: false, reason: 'claimed', order };
        if (order.claimed_by === userId) return { ok: true, order, already: true };
        if (api.ownsBook(userId, order.book_id)) {
          q('UPDATE ton_orders SET claimed_by = ? WHERE id = ?').run(userId, order.id);
          return { ok: true, order, already: true };
        }
        q('UPDATE ton_orders SET claimed_by = ? WHERE id = ?').run(userId, order.id);
        q('UPDATE purchases SET telegram_user_id = ? WHERE order_id = ? AND telegram_user_id IS NULL').run(userId, order.id);
        return { ok: true, order: api.getTonOrder(order.id), already: false };
      });
    },

    // ---------- support ----------
    getOpenTicket(userId) {
      return q(`SELECT * FROM support_tickets WHERE telegram_user_id = ? AND status = 'open'`).get(userId) || null;
    },
    openTicket(userId) {
      const existing = api.getOpenTicket(userId);
      if (existing) return { ticket: existing, created: false };
      const info = q(`INSERT INTO support_tickets (telegram_user_id, status, created_at) VALUES (?, 'open', ?)`).run(userId, now());
      return { ticket: q('SELECT * FROM support_tickets WHERE id = ?').get(Number(info.lastInsertRowid)), created: true };
    },
    getTicket(id) {
      return q('SELECT * FROM support_tickets WHERE id = ?').get(id) || null;
    },
    setTicketThread(id, threadId) {
      q('UPDATE support_tickets SET thread_id = ? WHERE id = ?').run(threadId, id);
    },
    getOpenTicketByThread(threadId) {
      return q(`SELECT * FROM support_tickets WHERE thread_id = ? AND status = 'open'`).get(threadId) || null;
    },
    closeTicket(id) {
      return q(`UPDATE support_tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'`).run(now(), id).changes === 1;
    },
    linkRelay(supportMessageId, ticketId) {
      q('INSERT OR REPLACE INTO support_relay (support_message_id, ticket_id) VALUES (?, ?)').run(supportMessageId, ticketId);
    },
    ticketForRelay(supportMessageId) {
      const r = q('SELECT ticket_id FROM support_relay WHERE support_message_id = ?').get(supportMessageId);
      return r ? api.getTicket(r.ticket_id) : null;
    },

    // ---------- Telegram file_id cache ----------
    getCachedFileId(p, mtimeMs) {
      const r = q('SELECT * FROM file_cache WHERE path = ?').get(p);
      return r && r.mtime_ms === Math.floor(mtimeMs) ? r.file_id : null;
    },
    cacheFileId(p, mtimeMs, fileId) {
      q('INSERT OR REPLACE INTO file_cache (path, mtime_ms, file_id) VALUES (?, ?, ?)').run(p, Math.floor(mtimeMs), fileId);
    },
  };
  return api;
}
