import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { verifyDownload } from './signing.js';
import { iconPng } from './icon.js';
import { starsPrice, formatTon } from '../pricing.js';
import { FORMATS } from '../files/storage.js';

const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 1 << 20) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fixed-window rate limiter keyed by client IP. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.start > windowMs) {
      hits.set(key, { start: t, n: 1 });
      if (hits.size > 10_000) hits.clear();
      return true;
    }
    return ++h.n <= max;
  };
}

export function createWebServer({ config, store, pricer, orders, files, onTelegramUpdate, log = console }) {
  const icon = iconPng();
  const orderLimit = rateLimiter(20, 60_000);
  const statusLimit = rateLimiter(240, 60_000);

  const manifest = () => ({
    url: config.publicUrl,
    name: 'Drop Shelf',
    iconUrl: `${config.publicUrl}/icon.png`,
    termsOfUseUrl: `${config.publicUrl}/#terms`,
  });

  const bookJson = (b) => ({
    slug: b.slug,
    kind: b.kind,
    title: b.title,
    pitch: b.pitch,
    audience: b.audience,
    isCurrentDrop: !!b.is_current_drop,
    launchEndsAt: b.launch_ends_at,
    starsPrice: starsPrice(b),
    tonPrice: formatTon(pricer.priceNano(b)),
    hasCover: !!files.coverPath(b),
  });

  async function route(req, res) {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

    if (req.method === 'POST' && path === '/telegram/webhook') {
      const given = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
      const expected = Buffer.from(config.bot.webhookSecret);
      if (!config.bot.webhookSecret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        res.writeHead(401); return res.end();
      }
      const update = JSON.parse(await readBody(req));
      // pre_checkout_query must be answered within seconds: handle it before acking.
      if (update.pre_checkout_query) await onTelegramUpdate(update);
      else setImmediate(() => onTelegramUpdate(update));
      res.writeHead(200); return res.end();
    }

    if (req.method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/tonconnect-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(manifest()));
    }
    if (req.method === 'GET' && path === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' });
      return res.end(icon);
    }
    if (req.method === 'GET' && path.startsWith('/covers/')) {
      const book = store.getBookBySlug(path.slice(8));
      const cover = book && files.coverPath(book);
      if (!cover) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': cover.endsWith('png') ? 'image/png' : 'image/jpeg', 'cache-control': 'public, max-age=3600' });
      return res.end(readFileSync(cover));
    }

    if (req.method === 'GET' && path === '/api/config') {
      return sendJson(res, 200, {
        network: config.ton.network,
        walletConfigured: !!config.ton.wallet,
        manifestUrl: `${config.publicUrl}/tonconnect-manifest.json`,
        discountPercent: Math.round(config.ton.discount * 100),
        downloadTtlHours: config.downloads.ttlHours,
      });
    }
    if (req.method === 'GET' && path === '/api/books') {
      return sendJson(res, 200, { books: store.activeBooks().map(bookJson) });
    }
    if (req.method === 'POST' && path === '/api/orders') {
      if (!orderLimit(ip)) return sendJson(res, 429, { error: 'Too many orders, slow down.' });
      if (!config.ton.wallet) return sendJson(res, 503, { error: 'TON checkout is not configured.' });
      let body;
      try { body = JSON.parse(await readBody(req, 4096)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const order = orders.create(String(body.slug || ''));
      if (!order) return sendJson(res, 404, { error: 'Book not available' });
      return sendJson(res, 201, order);
    }
    const m = path.match(/^\/api\/orders\/(DS-[A-Z0-9]{10})$/);
    if (req.method === 'GET' && m) {
      if (!statusLimit(ip)) return sendJson(res, 429, { error: 'Too many requests' });
      const status = orders.status(m[1], u.searchParams.get('token') || '');
      return status ? sendJson(res, 200, status) : sendJson(res, 404, { error: 'Order not found' });
    }

    const d = path.match(/^\/download\/(DS-[A-Z0-9]{10})\/(\d+)\/(epub|pdf)$/);
    if (req.method === 'GET' && d) {
      const [, orderId, bookIdStr, format] = d;
      const bookId = Number(bookIdStr);
      const exp = u.searchParams.get('exp');
      const sig = u.searchParams.get('sig');
      if (!verifyDownload(config.downloads.secret, { orderId, bookId, format, exp, sig })) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('This download link is invalid or has expired. Reopen your order page for a fresh link.');
      }
      const order = store.getTonOrder(orderId);
      const product = order && store.getBook(order.book_id);
      if (!order || order.status !== 'paid' || !store.unlockedBookIds(product).includes(bookId)) {
        res.writeHead(403); return res.end('Order not paid');
      }
      const book = store.getBook(bookId);
      const file = files.bookPath(book, format);
      if (!file) { res.writeHead(404); return res.end('File not available yet. Please contact support.'); }
      const data = format === 'pdf'
        ? await files.stampedPdf(file, `Licensed to web order ${order.id} · Drop Shelf · Please do not share`, log)
        : readFileSync(file);
      store.logEvent(null, 'web_download', { order: order.id, book: book.slug, format });
      res.writeHead(200, {
        'content-type': FORMATS[format],
        'content-length': data.length,
        'content-disposition': `attachment; filename="${book.slug}.${format}"`,
        'cache-control': 'private, no-store',
      });
      return res.end(data);
    }

    if (req.method === 'GET') {
      const file = path === '/' || /^\/book\/[a-z0-9-]+$/.test(path) ? 'index.html' : path.slice(1);
      const full = join(PUBLIC_DIR, file);
      if (!full.startsWith(PUBLIC_DIR) || !TYPES[extname(full)] || !existsSync(full)) {
        res.writeHead(404); return res.end('Not found');
      }
      res.writeHead(200, { 'content-type': TYPES[extname(full)] });
      return res.end(readFileSync(full));
    }
    res.writeHead(405); res.end();
  }

  return createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error?.(`[web] ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: 'Server error' });
      else res.end();
    });
  });
}
