import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { starsPrice, isLaunchPrice, launchHoursLeft, tonPriceNano, formatTon } from '../pricing.js';
import { bookFile, downloadName, FORMATS, MIME } from '../content.js';
import { signDownload, verifyDownload } from '../links.js';
import { commentPayloadBoc } from '../ton/comment.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Fixed-window limiter per key. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.start > windowMs) { hits.set(key, { start: t, n: 1 }); return true; }
    h.n += 1;
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
    return h.n <= max;
  };
}

export function publicBook(book, cfg) {
  return {
    id: book.id,
    drop: book.drop_number,
    title: book.title,
    pitch: book.pitch,
    featured: !!book.featured,
    launch: isLaunchPrice(book),
    launchHoursLeft: launchHoursLeft(book),
    stars: starsPrice(book),
    fullStars: book.full_stars,
    tonNano: tonPriceNano(book, cfg).toString(),
    ton: formatTon(tonPriceNano(book, cfg)),
    botLink: `https://t.me/${cfg.botUsername}?start=buy_${book.id}`,
  };
}

export function createWebServer({ db, cfg, bot = null, log = console, trustProxy = true }) {
  const orderLimit = rateLimiter(20, 10 * 60 * 1000);
  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  function orderView(order, { includeLinks }) {
    const book = db.getBook(order.book_id);
    const view = {
      orderId: order.id,
      status: order.status,
      book: { id: book.id, title: book.title },
      amountTon: formatTon(order.amount_nano),
      expiresAt: order.expires_at,
    };
    if (order.status === 'underpaid') view.receivedTon = formatTon(order.received_nano);
    if (includeLinks && order.status === 'paid') {
      view.downloads = Object.fromEntries(FORMATS.map((f) => [f, signDownload(cfg, { orderId: order.id, bookId: book.id, format: f })]));
      view.linkTtlMinutes = cfg.linkTtlMinutes;
      view.claimUrl = order.claimed_by ? null : `https://t.me/${cfg.botUsername}?start=claim_${order.claim_code}`;
      view.txHash = order.tx_hash;
    }
    return view;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    // Telegram webhook
    if (req.method === 'POST' && p === '/tg/webhook') {
      const token = req.headers['x-telegram-bot-api-secret-token'];
      const ok = bot && cfg.webhookSecret && typeof token === 'string' && token.length === cfg.webhookSecret.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cfg.webhookSecret));
      if (!ok) return json(res, 401, { ok: false });
      const update = JSON.parse(await readBody(req, 1_000_000));
      // Payment updates are handled before we reply: pre-checkout must land inside Telegram's 10s window,
      // and a failed successful_payment returns 500 so Telegram redelivers it.
      if (update.pre_checkout_query || update.message?.successful_payment) {
        try { await bot.handleUpdate(update); } catch { return json(res, 500, { ok: false }); }
      } else {
        bot.handleUpdate(update);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && p === '/tonconnect-manifest.json') {
      return json(res, 200, { url: cfg.publicUrl, name: 'Drop Shelf', iconUrl: `${cfg.publicUrl}/icon.png` });
    }

    if (req.method === 'GET' && p === '/api/books') {
      return json(res, 200, {
        network: cfg.tonNetwork,
        bot: `https://t.me/${cfg.botUsername}`,
        books: db.listLiveBooks().map((b) => publicBook(b, cfg)),
      });
    }

    if (req.method === 'POST' && p === '/api/orders') {
      if (!orderLimit(clientIp(req))) return json(res, 429, { error: 'Too many orders. Try again in a few minutes.' });
      let body;
      try { body = JSON.parse(await readBody(req, 10_000) || '{}'); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
      const book = typeof body.bookId === 'string' ? db.getBook(body.bookId) : null;
      if (!book || book.status !== 'live') return json(res, 404, { error: 'Book not found' });
      const amount = tonPriceNano(book, cfg);
      const { order, secret } = db.createTonOrder({ bookId: book.id, amountNano: amount, ttlMinutes: cfg.orderTtlMinutes });
      const validUntil = Math.min(order.expires_at, Math.floor(Date.now() / 1000) + 600);
      return json(res, 201, {
        ...orderView(order, { includeLinks: false }),
        key: secret, // view key: needed to read status and links; the order id itself is public on-chain
        transaction: {
          validUntil,
          messages: [{ address: cfg.tonReceiver, amount: amount.toString(), payload: commentPayloadBoc(order.id) }],
        },
      });
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/orders\/(DS-[A-Z0-9]{8})$/))) {
      const order = db.getTonOrder(m[1]);
      const key = req.headers['x-order-key'] || url.searchParams.get('key');
      if (!order || !db.checkOrderSecret(order, key)) return json(res, 404, { error: 'Order not found' });
      return json(res, 200, orderView(order, { includeLinks: true }));
    }

    if (req.method === 'GET' && (m = p.match(/^\/dl\/([A-Za-z0-9_.-]+)$/))) {
      const claims = verifyDownload(cfg, m[1]);
      if (!claims) return json(res, 410, { error: 'This download link is invalid or has expired. Reopen your order page for a fresh link.' });
      const order = db.getTonOrder(claims.orderId);
      const book = db.getBook(claims.bookId);
      if (!order || order.status !== 'paid' || !book || order.book_id !== book.id || !FORMATS.includes(claims.format)) {
        return json(res, 404, { error: 'Not found' });
      }
      const file = bookFile(cfg, book.id, claims.format);
      if (!fs.existsSync(file)) {
        log.error?.(`download missing file ${file}`);
        return json(res, 503, { error: 'File is being prepared. Please try again shortly.' });
      }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'content-type': MIME[claims.format],
        'content-length': stat.size,
        'content-disposition': `attachment; filename="${downloadName(book, claims.format)}"`,
        'cache-control': 'private, no-store',
      });
      return fs.createReadStream(file).pipe(res);
    }

    // Static files from /public
    if (req.method === 'GET') {
      const rel = p === '/' ? '/index.html' : p;
      const file = path.resolve(PUBLIC_DIR, `.${rel}`);
      if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'public, max-age=300' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    return json(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error?.(`http ${req.method} ${req.url}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status === 413 ? 'Payload too large' : 'Server error' });
      else res.end();
    });
  });
  return server;
}
