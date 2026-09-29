import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginCell, Cell } from '@ton/core';
import { commentPayloadBoc, crc32c } from '../src/ton/comment.js';
import { TonWatcher } from '../src/ton/watcher.js';
import { TonPricer, formatTon, starsPrice } from '../src/pricing.js';
import { signDownload, verifyDownload } from '../src/web/signing.js';
import { createWebServer } from '../src/web/server.js';
import { makeApp, quietLog, user, textUpdate } from './helpers.js';

test('comment payload BOC matches @ton/core byte for byte and decodes', () => {
  for (const comment of ['DS-ABCDEFGH23', 'hello', 'x'.repeat(123)]) {
    const ours = commentPayloadBoc(comment);
    const ref = beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc({ idx: false, crc32: true }).toString('base64');
    assert.equal(ours, ref, comment);
    const slice = Cell.fromBase64(ours).beginParse();
    assert.equal(slice.loadUint(32), 0);
    assert.equal(slice.loadStringTail(), comment);
  }
  assert.throws(() => commentPayloadBoc('x'.repeat(124)));
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

test('TON price: discounted from the Stars price and rounded up to 0.01 TON', () => {
  const pricer = new TonPricer({ pricingMode: 'fixed', starUsd: 0.013, discount: 0.12, tonUsd: 3 });
  // 300 Stars * $0.013 * 0.88 / $3 = 1.144 TON -> 1.15
  assert.equal(formatTon(pricer.nanoForStars(300)), '1.15');
  assert.equal(formatTon(pricer.nanoForStars(150)), '0.58');
  assert.equal(formatTon(1_000_000_000n), '1');
  const book = { launch_price_stars: 300, full_price_stars: 450, launch_ends_at: Date.now() - 1 };
  assert.equal(starsPrice(book), 450);
});

test('usd_peg mode refreshes the rate and falls back on failure', async () => {
  const cfg = { pricingMode: 'usd_peg', starUsd: 0.013, discount: 0.12, tonUsd: 3, rateUrl: 'https://rates' };
  const ok = new TonPricer(cfg, { fetchImpl: async () => ({ json: async () => ({ rates: { TON: { prices: { USD: 2 } } } }) }), log: quietLog });
  await ok.refreshRate();
  assert.equal(formatTon(ok.nanoForStars(300)), '1.72');
  const bad = new TonPricer(cfg, { fetchImpl: async () => { throw new Error('down'); }, log: quietLog });
  await bad.refreshRate();
  assert.equal(bad.tonUsd, 3);
});

test('signed download links verify, and reject tampering and expiry', () => {
  const now = Date.now();
  const p = { orderId: 'DS-AAAAAAAAAA', bookId: 1, format: 'pdf', exp: Math.floor(now / 1000) + 60 };
  const sig = signDownload('s', p);
  assert.ok(verifyDownload('s', { ...p, sig }, now));
  assert.ok(!verifyDownload('s', { ...p, format: 'epub', sig }, now));
  assert.ok(!verifyDownload('s', { ...p, bookId: 2, sig }, now));
  assert.ok(!verifyDownload('other', { ...p, sig }, now));
  assert.ok(!verifyDownload('s', { ...p, sig }, now + 120_000));
});

const tx = (hash, comment, value, source = 'EQBuyer') => ({
  transaction_id: { lt: String(Date.now()), hash },
  in_msg: { source, destination: 'UQShopWallet', value: String(value), message: comment },
});

test('order creation returns a prefilled transfer with the order id as comment', async () => {
  const app = await makeApp();
  const o = app.orders.create('ai-control-center');
  assert.match(o.orderId, /^DS-[A-Z2-9]{10}$/);
  assert.equal(o.comment, o.orderId);
  assert.equal(o.address, 'UQShopWallet');
  assert.equal(o.amountNano, '1150000000');
  assert.equal(Cell.fromBase64(o.payload).beginParse().skip(32).loadStringTail(), o.orderId);
  assert.equal(app.orders.create('nope'), null);
  // Status requires the access token, which never goes on-chain.
  assert.equal(app.orders.status(o.orderId, 'wrong'), null);
  assert.equal(app.orders.status(o.orderId, o.accessToken).status, 'pending');
  assert.equal(app.orders.status(o.orderId, o.accessToken).downloads, undefined);
});

test('watcher matches comment + amount, ignores underpayments and duplicates', async () => {
  const app = await makeApp();
  const o = app.orders.create('drop-shelf-bundle');
  const other = app.orders.create('first-ai-workflow-weekend');
  const paid = [];
  const watcher = new TonWatcher({ store: app.store, config: app.config, log: quietLog, onPaid: (x) => paid.push(x.id) });

  let result = watcher.processTransactions([
    tx('h1', o.orderId, BigInt(o.amountNano) - 1n),  // underpaid
    tx('h2', 'random comment', o.amountNano),         // unrelated
    tx('h3', other.orderId, other.amountNano, ''),    // no source (external) -> skipped
  ]);
  assert.equal(result.length, 0);
  assert.equal(app.store.getTonOrder(o.orderId).status, 'pending');

  result = watcher.processTransactions([tx('h4', ` ${o.orderId} `, BigInt(o.amountNano) + 5n)]);
  assert.equal(result.length, 1);
  const order = app.store.getTonOrder(o.orderId);
  assert.equal(order.status, 'paid');
  assert.equal(order.tx_hash, 'h4');

  // Re-seeing the same tx or a second payment does not re-trigger.
  assert.equal(watcher.processTransactions([tx('h4', o.orderId, o.amountNano), tx('h5', o.orderId, o.amountNano)]).length, 0);

  const s = app.orders.status(o.orderId, o.accessToken);
  assert.equal(s.status, 'paid');
  assert.equal(s.downloads.length, 6, 'bundle: 3 books x 2 formats');
  assert.match(s.claimUrl, /^https:\/\/t\.me\/YourShelfBot\?start=claim_/);
});

test('watcher tick polls toncenter, expires old orders, and fires onPaid', async () => {
  const app = await makeApp({ TONCENTER_API_KEY: 'k' });
  const o = app.orders.create('ai-control-center');
  let requested;
  const fetchImpl = async (url, init) => {
    requested = { url: String(url), init };
    return { status: 200, json: async () => ({ ok: true, result: [tx('hh', o.orderId, o.amountNano)] }) };
  };
  const paid = [];
  const w = new TonWatcher({ store: app.store, config: app.config, fetchImpl, log: quietLog, onPaid: (x) => paid.push(x.id) });
  await w.tick();
  assert.match(requested.url, /getTransactions\?address=UQShopWallet/);
  assert.equal(requested.init.headers['X-API-Key'], 'k');
  assert.deepEqual(paid, [o.orderId]);
});

test('late payment for an expired order is still honoured', async () => {
  const app = await makeApp({ TON_ORDER_TTL_MINUTES: '0' });
  const o = app.orders.create('ai-control-center');
  await new Promise((r) => setTimeout(r, 5));
  app.store.expireTonOrders();
  assert.equal(app.store.getTonOrder(o.orderId).status, 'expired');
  const w = new TonWatcher({ store: app.store, config: app.config, log: quietLog });
  assert.equal(w.processTransactions([tx('late', o.orderId, o.amountNano)]).length, 1);
});

test('claiming a web order adds it to the Telegram library once, with the tx hash', async () => {
  const app = await makeApp();
  const o = app.orders.create('ai-control-center');
  new TonWatcher({ store: app.store, config: app.config, log: quietLog }).processTransactions([tx('txhash1', o.orderId, o.amountNano)]);
  const token = app.orders.status(o.orderId, o.accessToken).claimUrl.split('claim_')[1];
  await app.bot.handleUpdate(textUpdate(user(90), `/start claim_${token}`));
  const p = app.store.getUserProfile(90).purchases[0];
  assert.equal(p.method, 'ton');
  assert.equal(p.charge_id, 'txhash1');
  assert.equal(p.ton_paid_nano, o.amountNano);
  await app.bot.handleUpdate(textUpdate(user(91), `/start claim_${token}`));
  assert.match(app.api.texts(91).at(-1), /already been added/);
  assert.equal(app.orders.status(o.orderId, o.accessToken).claimUrl, null);
});

async function withServer(app, fn) {
  const updates = [];
  const server = createWebServer({ ...app, log: quietLog, onTelegramUpdate: async (u) => updates.push(u) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, updates); } finally { server.close(); }
}

test('web API: books, order, status, signed download, manifest, webhook secret', async () => {
  const app = await makeApp();
  await withServer(app, async (base, updates) => {
    const books = await (await fetch(`${base}/api/books`)).json();
    assert.equal(books.books[0].slug, 'ai-control-center');
    assert.equal(books.books[0].tonPrice, '1.15');
    assert.equal(books.books[0].starsPrice, 300);

    const manifest = await (await fetch(`${base}/tonconnect-manifest.json`)).json();
    assert.equal(manifest.iconUrl, 'https://shop.example/icon.png');
    const icon = await fetch(`${base}/icon.png`);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.deepEqual([...Buffer.from(await icon.arrayBuffer()).subarray(1, 4)], [0x50, 0x4e, 0x47]);

    const res = await fetch(`${base}/api/orders`, { method: 'POST', body: JSON.stringify({ slug: 'ai-control-center' }) });
    assert.equal(res.status, 201);
    const order = await res.json();
    assert.equal((await fetch(`${base}/api/orders/${order.orderId}?token=bad`)).status, 404);

    new TonWatcher({ store: app.store, config: app.config, log: quietLog }).processTransactions([tx('webtx', order.orderId, order.amountNano)]);
    const status = await (await fetch(`${base}/api/orders/${order.orderId}?token=${order.accessToken}`)).json();
    assert.equal(status.status, 'paid');
    const pdfLink = status.downloads.find((d) => d.format === 'pdf').url.replace('https://shop.example', base);
    const dl = await fetch(pdfLink);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.match(Buffer.from(await dl.arrayBuffer()).toString('latin1'), /^%PDF/);
    assert.equal((await fetch(pdfLink.replace(/sig=[^&]+/, 'sig=forged'))).status, 403);

    // Webhook requires the secret token header.
    const update = { update_id: 1, message: { text: '/start' } };
    assert.equal((await fetch(`${base}/telegram/webhook`, { method: 'POST', body: JSON.stringify(update) })).status, 401);
    const ok = await fetch(`${base}/telegram/webhook`, { method: 'POST', body: JSON.stringify(update), headers: { 'x-telegram-bot-api-secret-token': 'hook' } });
    assert.equal(ok.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(updates.length, 1);

    const page = await fetch(`${base}/book/ai-control-center`);
    assert.match(await page.text(), /tonconnect-ui/);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  });
});

test('web API refuses orders when no wallet is configured', async () => {
  const app = await makeApp({ TON_WALLET_ADDRESS: '' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/orders`, { method: 'POST', body: JSON.stringify({ slug: 'ai-control-center' }) });
    assert.equal(res.status, 503);
  });
});

test('metrics cover the funnel described in the spec', async () => {
  const app = await makeApp();
  const { buyWithStars } = await import('./helpers.js');
  await app.bot.handleUpdate(textUpdate(user(1), '/sample'));
  await buyWithStars(app, user(1), 'ai-control-center');
  await app.bot.handleUpdate(textUpdate(user(2), '/sample'));
  const m = app.store.metrics();
  assert.equal(m.sample_to_purchase.sample_users, 2);
  assert.equal(m.sample_to_purchase.bought_after_sample, 1);
  assert.equal(m.stars_vs_ton.stars_sales, 1);
  assert.equal(m.stars_vs_ton.stars_revenue, 300);
  assert.equal(m.drop_alert_opt_ins, 2);
});
