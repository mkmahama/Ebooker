import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWebServer } from '../src/web/server.js';
import { createBot } from '../src/bot/bot.js';
import { signDownload, verifyDownload } from '../src/links.js';
import { decodeCommentBoc } from '../src/ton/comment.js';
import { makeCfg, makeDb, fakeApi, silentLog, msgUpdate } from './helpers.js';

async function start() {
  const cfg = makeCfg();
  const db = makeDb();
  const api = fakeApi();
  const bot = createBot({ db, api, cfg, log: silentLog });
  const server = createWebServer({ db, cfg, bot, log: silentLog });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => server.close(r));
  return { cfg, db, api, bot, base, close };
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('catalog API exposes TON prices below Stars prices, current drop first', async () => {
  const s = await start();
  try {
    s.db.startLaunch('ai-channel-automation', 24);
    const data = await (await fetch(`${s.base}/api/books`)).json();
    assert.equal(data.network, 'testnet');
    assert.equal(data.books[0].id, 'ai-channel-automation');
    assert.equal(data.books[0].launch, true);
    assert.deepEqual(data.books.map((b) => b.ton), ['0.88', '1.98', '0.66']);
    assert.equal(data.books[1].botLink, 'https://t.me/YourShelfBot?start=buy_ai-control-center');
  } finally { await s.close(); }
});

test('order -> prefilled TON Connect transfer -> watcher-style settle -> signed expiring links', async () => {
  const s = await start();
  try {
    const res = await post(`${s.base}/api/orders`, { bookId: 'ai-control-center' });
    assert.equal(res.status, 201);
    const order = await res.json();
    assert.match(order.orderId, /^DS-[A-Z0-9]{8}$/);
    const msg = order.transaction.messages[0];
    assert.equal(msg.address, 'UQTESTRECEIVER');
    assert.equal(msg.amount, '1980000000');
    assert.equal(decodeCommentBoc(msg.payload), order.orderId);
    assert.ok(order.transaction.validUntil <= order.expiresAt);

    // status needs the view key
    assert.equal((await fetch(`${s.base}/api/orders/${order.orderId}`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/orders/${order.orderId}?key=wrong`)).status, 404);
    let st = await (await fetch(`${s.base}/api/orders/${order.orderId}`, { headers: { 'x-order-key': order.key } })).json();
    assert.equal(st.status, 'pending');
    assert.equal(st.downloads, undefined);

    s.db.settleTonOrder({ orderId: order.orderId, txHash: 'tx1', receivedNano: '1980000000', lt: '1' });
    st = await (await fetch(`${s.base}/api/orders/${order.orderId}`, { headers: { 'x-order-key': order.key } })).json();
    assert.equal(st.status, 'paid');
    assert.match(st.downloads.pdf, /^https:\/\/shop\.test\/dl\//);
    assert.match(st.claimUrl, /^https:\/\/t\.me\/YourShelfBot\?start=claim_[A-Z0-9]{12}$/);

    const token = st.downloads.pdf.split('/dl/')[1];
    const dl = await fetch(`${s.base}/dl/${token}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.match(dl.headers.get('content-disposition'), /Telegram-as-Your-AI-Control-Center\.pdf/);
    const expected = fs.readFileSync(path.join(s.cfg.contentDir, 'books/ai-control-center/book.pdf'));
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(expected));

    // tampered and expired tokens
    const [body, sig] = token.split('.');
    assert.equal((await fetch(`${s.base}/dl/${body}.${sig.slice(0, -2)}xx`)).status, 410);
    const old = signDownload(s.cfg, { orderId: order.orderId, bookId: 'ai-control-center', format: 'pdf' }, Date.now() - 2 * 3600 * 1000);
    assert.equal((await fetch(`${s.base}/dl/${old.split('/dl/')[1]}`)).status, 410);
    // a valid signature for a different, unpaid order is refused
    const other = await (await post(`${s.base}/api/orders`, { bookId: 'first-ai-workflow' })).json();
    const forged = signDownload(s.cfg, { orderId: other.orderId, bookId: 'first-ai-workflow', format: 'pdf' });
    assert.equal((await fetch(`${s.base}/dl/${forged.split('/dl/')[1]}`)).status, 404);
  } finally { await s.close(); }
});

test('web buyer can add the book to a Telegram library via the claim link', async () => {
  const s = await start();
  try {
    const order = await (await post(`${s.base}/api/orders`, { bookId: 'first-ai-workflow' })).json();
    s.db.settleTonOrder({ orderId: order.orderId, txHash: 'tx9', receivedNano: '660000000', lt: '9' });
    const st = await (await fetch(`${s.base}/api/orders/${order.orderId}?key=${order.key}`)).json();
    const code = st.claimUrl.split('claim_')[1];
    const user = { id: 777, first_name: 'Web' };
    await s.bot.handleUpdate(msgUpdate(user, `/start claim_${code}`));
    assert.ok(s.db.ownsBook(777, 'first-ai-workflow'));
    assert.equal(s.api.of('sendDocument').length, 2);
    const other = { id: 778 };
    await s.bot.handleUpdate(msgUpdate(other, `/start claim_${code}`));
    assert.equal(s.db.ownsBook(778, 'first-ai-workflow'), false);
    const after = await (await fetch(`${s.base}/api/orders/${order.orderId}?key=${order.key}`)).json();
    assert.equal(after.claimUrl, null);
  } finally { await s.close(); }
});

test('order validation and rate limiting', async () => {
  const s = await start();
  try {
    assert.equal((await post(`${s.base}/api/orders`, { bookId: 'nope' })).status, 404);
    assert.equal((await fetch(`${s.base}/api/orders`, { method: 'POST', body: '{bad' })).status, 400);
    s.db.setBookStatus('first-ai-workflow', 'hidden');
    assert.equal((await post(`${s.base}/api/orders`, { bookId: 'first-ai-workflow' })).status, 404);
    let last;
    for (let i = 0; i < 21; i++) last = await post(`${s.base}/api/orders`, { bookId: 'ai-control-center' }, { 'x-forwarded-for': '9.9.9.9' });
    assert.equal(last.status, 429);
  } finally { await s.close(); }
});

test('Telegram webhook requires the secret token and answers pre-checkout', async () => {
  const s = await start();
  try {
    const upd = { update_id: 1, pre_checkout_query: { id: 'q1', from: { id: 5 }, currency: 'XTR', total_amount: 1, invoice_payload: 'bad' } };
    assert.equal((await post(`${s.base}/tg/webhook`, upd)).status, 401);
    assert.equal((await post(`${s.base}/tg/webhook`, upd, { 'x-telegram-bot-api-secret-token': 'wrong-secret' })).status, 401);
    const ok = await post(`${s.base}/tg/webhook`, upd, { 'x-telegram-bot-api-secret-token': 'whsecret-123' });
    assert.equal(ok.status, 200);
    assert.equal(s.api.of('answerPreCheckoutQuery')[0].params.ok, false);
  } finally { await s.close(); }
});

test('serves the checkout page, manifest and icon; blocks path traversal', async () => {
  const s = await start();
  try {
    const html = await (await fetch(`${s.base}/`)).text();
    assert.match(html, /tonconnect-ui\.min\.js/);
    const manifest = await (await fetch(`${s.base}/tonconnect-manifest.json`)).json();
    assert.deepEqual(manifest, { url: 'https://shop.test', name: 'Drop Shelf', iconUrl: 'https://shop.test/icon.png' });
    assert.equal((await fetch(`${s.base}/icon.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${s.base}/..%2Fsrc%2Fconfig.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/../package.json`)).status, 404);
  } finally { await s.close(); }
});

test('signed links verify, and reject other secrets', () => {
  const cfg = makeCfg();
  const url = signDownload(cfg, { orderId: 'DS-AAAAAAAA', bookId: 'first-ai-workflow', format: 'epub' });
  const token = url.split('/dl/')[1];
  assert.equal(verifyDownload(cfg, token).bookId, 'first-ai-workflow');
  assert.equal(verifyDownload({ ...cfg, linkSecret: 'y'.repeat(40) }, token), null);
  assert.equal(verifyDownload(cfg, 'nodot'), null);
});
