import { randomBytes } from 'node:crypto';
import { tx } from './db/index.js';

const now = () => Date.now();

// Unambiguous uppercase alphabet for codes humans may read or type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(len) {
  const bytes = randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function parseBook(row) {
  if (!row) return null;
  return { ...row, bundle_items: row.bundle_items ? JSON.parse(row.bundle_items) : null };
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---------- users ----------

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ?').get(id) || null;
  }

  getUserByReferralCode(code) {
    return this.db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code) || null;
  }

  /** Returns { user, created }. Updates username/first_name on every call. */
  upsertUser(from) {
    const existing = this.getUser(from.id);
    if (existing) {
      this.db.prepare('UPDATE users SET username = ?, first_name = ? WHERE telegram_user_id = ?')
        .run(from.username || null, from.first_name || null, from.id);
      return { user: this.getUser(from.id), created: false };
    }
    for (let i = 0; i < 5; i++) {
      try {
        this.db.prepare(`INSERT INTO users (telegram_user_id, username, first_name, referral_code, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(from.id, from.username || null, from.first_name || null, randomCode(8), now());
        return { user: this.getUser(from.id), created: true };
      } catch (err) {
        if (!String(err.message).includes('referral_code')) throw err;
      }
    }
    throw new Error('could not allocate referral code');
  }

  /** Sets the referrer once, only for a user who has none and is not referring themselves. */
  setReferrer(userId, referrerId) {
    if (userId === referrerId) return false;
    const r = this.db.prepare('UPDATE users SET referrer_id = ? WHERE telegram_user_id = ? AND referrer_id IS NULL')
      .run(referrerId, userId);
    return r.changes > 0;
  }

  setAlertOptIn(userId, on) {
    this.db.prepare('UPDATE users SET alert_opt_in = ? WHERE telegram_user_id = ?').run(on ? 1 : 0, userId);
  }

  alertSubscribers() {
    return this.db.prepare('SELECT telegram_user_id FROM users WHERE alert_opt_in = 1').all().map((r) => r.telegram_user_id);
  }

  /** The user record in the shape of the product spec: user fields + purchases array. */
  getUserProfile(id) {
    const user = this.getUser(id);
    if (!user) return null;
    const purchases = this.db.prepare(`
      SELECT p.book_id, b.slug, p.method, p.stars_paid, p.ton_paid_nano, p.charge_id, p.created_at, p.refunded_at
      FROM purchases p JOIN books b ON b.id = p.book_id
      WHERE p.telegram_user_id = ? ORDER BY p.created_at`).all(id);
    return {
      telegram_user_id: user.telegram_user_id,
      referral_code: user.referral_code,
      referrer_id: user.referrer_id,
      alert_opt_in: !!user.alert_opt_in,
      purchases,
    };
  }

  // ---------- books ----------

  getBook(id) {
    return parseBook(this.db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  }

  getBookBySlug(slug) {
    return parseBook(this.db.prepare('SELECT * FROM books WHERE slug = ?').get(slug));
  }

  /** Active products, current drop first, then books before bundles, then sort order. */
  activeBooks() {
    return this.db.prepare(`SELECT * FROM books WHERE active = 1
      ORDER BY is_current_drop DESC, (kind = 'bundle') ASC, sort_order ASC, id ASC`).all().map(parseBook);
  }

  /** Book ids a product unlocks (a bundle unlocks its items). */
  unlockedBookIds(book) {
    return book.kind === 'bundle' ? book.bundle_items || [] : [book.id];
  }

  startDrop(slug, launchHours) {
    return tx(this.db, () => {
      const book = this.getBookBySlug(slug);
      if (!book) throw new Error(`unknown book ${slug}`);
      this.db.prepare('UPDATE books SET is_current_drop = 0').run();
      this.db.prepare('UPDATE books SET is_current_drop = 1, active = 1, launch_ends_at = ? WHERE id = ?')
        .run(now() + launchHours * 3600_000, book.id);
      return this.getBook(book.id);
    });
  }

  setBookField(slug, field, value) {
    const allowed = ['active', 'launch_ends_at', 'reader_group_url', 'launch_price_stars', 'full_price_stars', 'is_current_drop'];
    if (!allowed.includes(field)) throw new Error(`field ${field} not editable`);
    this.db.prepare(`UPDATE books SET ${field} = ? WHERE slug = ?`).run(value, slug);
    return this.getBookBySlug(slug);
  }

  // ---------- purchases / library ----------

  /** Book ids the user owns through any non-refunded purchase (bundles expanded). */
  ownedBookIds(userId) {
    const rows = this.db.prepare(`SELECT DISTINCT book_id FROM purchases
      WHERE telegram_user_id = ? AND refunded_at IS NULL`).all(userId);
    const ids = new Set();
    for (const { book_id } of rows) {
      for (const id of this.unlockedBookIds(this.getBook(book_id))) ids.add(id);
    }
    return ids;
  }

  ownsAll(userId, book) {
    const owned = this.ownedBookIds(userId);
    return this.unlockedBookIds(book).every((id) => owned.has(id));
  }

  /** Books (never bundles) in the user's library, in shelf order. */
  libraryBooks(userId) {
    const owned = this.ownedBookIds(userId);
    return [...owned].map((id) => this.getBook(id)).filter(Boolean).sort((a, b) => a.sort_order - b.sort_order);
  }

  /** Inserts a purchase; returns the row, or null when charge_id was already recorded (idempotent). */
  recordPurchase({ userId, bookId, method, starsPaid = 0, tonPaidNano = null, chargeId, providerChargeId = null }) {
    const r = this.db.prepare(`INSERT INTO purchases
      (telegram_user_id, book_id, method, stars_paid, ton_paid_nano, charge_id, provider_charge_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(charge_id) DO NOTHING`)
      .run(userId, bookId, method, starsPaid, tonPaidNano, chargeId, providerChargeId, now());
    if (r.changes === 0) return null;
    return this.db.prepare('SELECT * FROM purchases WHERE id = ?').get(r.lastInsertRowid);
  }

  getPurchaseByCharge(chargeId) {
    return this.db.prepare('SELECT * FROM purchases WHERE charge_id = ?').get(chargeId) || null;
  }

  markRefunded(chargeId) {
    const r = this.db.prepare('UPDATE purchases SET refunded_at = ? WHERE charge_id = ? AND refunded_at IS NULL').run(now(), chargeId);
    return r.changes > 0;
  }

  paidPurchaseCount(userId) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM purchases
      WHERE telegram_user_id = ? AND method IN ('stars', 'ton') AND refunded_at IS NULL`).get(userId).n;
  }

  // ---------- referrals ----------

  /** Referred users who have made at least one paid, non-refunded purchase. */
  qualifiedReferralCount(referrerId) {
    return this.db.prepare(`SELECT COUNT(DISTINCT u.telegram_user_id) AS n FROM users u
      JOIN purchases p ON p.telegram_user_id = u.telegram_user_id
      WHERE u.referrer_id = ? AND p.method IN ('stars', 'ton') AND p.refunded_at IS NULL`).get(referrerId).n;
  }

  referredUserCount(referrerId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?').get(referrerId).n;
  }

  /** Marks the reward as granted; returns false if it was already granted (so it is granted once). */
  claimReferralReward(userId) {
    const r = this.db.prepare(`UPDATE users SET referral_reward_granted_at = ?
      WHERE telegram_user_id = ? AND referral_reward_granted_at IS NULL`).run(now(), userId);
    return r.changes > 0;
  }

  // ---------- Stars invoices ----------

  createInvoice(userId, bookId, starsAmount) {
    const id = `i${randomCode(12)}`;
    this.db.prepare('INSERT INTO invoices (id, telegram_user_id, book_id, stars_amount, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, bookId, starsAmount, now());
    return this.getInvoice(id);
  }

  getInvoice(id) {
    return this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) || null;
  }

  markInvoicePaid(id) {
    this.db.prepare('UPDATE invoices SET paid_at = ? WHERE id = ? AND paid_at IS NULL').run(now(), id);
  }

  // ---------- TON orders ----------

  createTonOrder({ bookId, amountNano, ttlMinutes }) {
    const t = now();
    for (let i = 0; i < 5; i++) {
      const id = `DS-${randomCode(10)}`;
      try {
        this.db.prepare(`INSERT INTO ton_orders (id, access_token, book_id, amount_nano, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(id, randomBytes(24).toString('base64url'), bookId, String(amountNano), t, t + ttlMinutes * 60_000);
        return this.getTonOrder(id);
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err;
      }
    }
    throw new Error('could not allocate order id');
  }

  getTonOrder(id) {
    return this.db.prepare('SELECT * FROM ton_orders WHERE id = ?').get(id) || null;
  }

  getTonOrderByClaimToken(token) {
    return this.db.prepare('SELECT * FROM ton_orders WHERE claim_token = ?').get(token) || null;
  }

  /** Marks an unpaid order paid; returns true only for the first caller. */
  markTonOrderPaid(id, { txHash, sender, paidNano }) {
    const r = this.db.prepare(`UPDATE ton_orders SET status = 'paid', tx_hash = ?, sender = ?, paid_nano = ?, paid_at = ?,
      claim_token = ? WHERE id = ? AND status IN ('pending', 'expired')`)
      .run(txHash, sender, String(paidNano), now(), randomBytes(18).toString('base64url'), id);
    return r.changes > 0;
  }

  expireTonOrders() {
    return this.db.prepare(`UPDATE ton_orders SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`).run(now()).changes;
  }

  /** Links a paid web order to a Telegram user; returns true for the first claim only. */
  claimTonOrder(id, userId) {
    const r = this.db.prepare(`UPDATE ton_orders SET claimed_by = ? WHERE id = ? AND status = 'paid' AND claimed_by IS NULL`).run(userId, id);
    return r.changes > 0;
  }

  hasSeenTx(hash) {
    return !!this.db.prepare('SELECT 1 FROM ton_seen_tx WHERE hash = ?').get(hash);
  }

  markTxSeen(hash, lt, matchedOrderId, note) {
    this.db.prepare(`INSERT INTO ton_seen_tx (hash, lt, matched_order_id, note, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO NOTHING`).run(hash, String(lt), matchedOrderId, note, now());
  }

  // ---------- file cache ----------

  getCachedFileId(path, mtimeMs) {
    const row = this.db.prepare('SELECT * FROM file_cache WHERE path = ?').get(path);
    return row && row.mtime_ms === Math.floor(mtimeMs) ? row.file_id : null;
  }

  setCachedFileId(path, mtimeMs, fileId) {
    this.db.prepare(`INSERT INTO file_cache (path, mtime_ms, file_id) VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, file_id = excluded.file_id`).run(path, Math.floor(mtimeMs), fileId);
  }

  // ---------- support ----------

  openTicket(userId) {
    return this.db.prepare(`SELECT * FROM support_tickets WHERE telegram_user_id = ? AND status = 'open'
      ORDER BY id DESC LIMIT 1`).get(userId) || null;
  }

  createTicket(userId) {
    const r = this.db.prepare('INSERT INTO support_tickets (telegram_user_id, created_at) VALUES (?, ?)').run(userId, now());
    return this.getTicket(r.lastInsertRowid);
  }

  getTicket(id) {
    return this.db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) || null;
  }

  getTicketByTopic(topicId) {
    return this.db.prepare(`SELECT * FROM support_tickets WHERE topic_id = ? ORDER BY id DESC LIMIT 1`).get(topicId) || null;
  }

  setTicketTopic(id, topicId) {
    this.db.prepare('UPDATE support_tickets SET topic_id = ? WHERE id = ?').run(topicId, id);
  }

  closeTicket(id) {
    const r = this.db.prepare(`UPDATE support_tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'`).run(now(), id);
    return r.changes > 0;
  }

  linkSupportMessage(messageId, ticketId) {
    this.db.prepare(`INSERT INTO support_messages (support_message_id, ticket_id) VALUES (?, ?)
      ON CONFLICT(support_message_id) DO NOTHING`).run(messageId, ticketId);
  }

  ticketForSupportMessage(messageId) {
    const row = this.db.prepare('SELECT ticket_id FROM support_messages WHERE support_message_id = ?').get(messageId);
    return row ? this.getTicket(row.ticket_id) : null;
  }

  // ---------- events / kv ----------

  logEvent(userId, type, data = null) {
    this.db.prepare('INSERT INTO events (telegram_user_id, type, data, created_at) VALUES (?, ?, ?, ?)')
      .run(userId ?? null, type, data === null ? null : JSON.stringify(data), now());
  }

  getKv(key) {
    return this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
  }

  setKv(key, value) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  // ---------- metrics ----------

  metrics() {
    const one = (sql, ...a) => this.db.prepare(sql).get(...a);
    const sampleUsers = one(`SELECT COUNT(DISTINCT telegram_user_id) AS n FROM events WHERE type = 'sample'`).n;
    const sampleBuyers = one(`SELECT COUNT(DISTINCT e.telegram_user_id) AS n FROM events e
      JOIN purchases p ON p.telegram_user_id = e.telegram_user_id AND p.method IN ('stars', 'ton') AND p.created_at >= e.created_at
      WHERE e.type = 'sample'`).n;
    const split = one(`SELECT
      SUM(method = 'stars' AND refunded_at IS NULL) AS stars_sales,
      SUM(CASE WHEN method = 'stars' AND refunded_at IS NULL THEN stars_paid ELSE 0 END) AS stars_revenue,
      SUM(method = 'ton' AND refunded_at IS NULL) AS ton_claimed_sales,
      SUM(method IN ('stars', 'ton')) AS paid_total,
      SUM(method IN ('stars', 'ton') AND refunded_at IS NOT NULL) AS refunded
      FROM purchases`);
    const ton = one(`SELECT COUNT(*) AS n, COALESCE(SUM(CAST(paid_nano AS INTEGER)), 0) AS nano FROM ton_orders WHERE status = 'paid'`);
    const referralSales = one(`SELECT COUNT(*) AS n FROM purchases p JOIN users u ON u.telegram_user_id = p.telegram_user_id
      WHERE u.referrer_id IS NOT NULL AND p.method IN ('stars', 'ton') AND p.refunded_at IS NULL`).n;
    const optIns = one('SELECT COUNT(*) AS n FROM users WHERE alert_opt_in = 1').n;
    const users = one('SELECT COUNT(*) AS n FROM users').n;
    const starsSales = split.stars_sales || 0;
    const allSales = starsSales + ton.n;
    return {
      users,
      sample_to_purchase: { sample_users: sampleUsers, bought_after_sample: sampleBuyers, rate: sampleUsers ? sampleBuyers / sampleUsers : 0 },
      stars_vs_ton: { stars_sales: starsSales, stars_revenue: split.stars_revenue || 0, ton_sales: ton.n, ton_revenue_nano: String(ton.nano) },
      referral_sales_share: { referral_sales: referralSales, share: allSales ? referralSales / allSales : 0 },
      refund_rate: { refunded: split.refunded || 0, paid_total: split.paid_total || 0, rate: split.paid_total ? (split.refunded || 0) / split.paid_total : 0 },
      drop_alert_opt_ins: optIns,
    };
  }
}
