import test from 'node:test';
import assert from 'node:assert/strict';
import { commentPayloadBoc, decodeCommentBoc, crc32c } from '../src/ton/comment.js';
import { createWatcher, inMsgComment } from '../src/ton/watcher.js';
import { tonPriceNano, formatTon, starsPrice } from '../src/pricing.js';
import { makeCfg, makeDb, silentLog } from './helpers.js';

test('crc32c matches the standard check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')).toString(16), 'e3069283');
});

test('comment payload is byte-identical to @ton/core output', () => {
  // Known @ton/core serialization of beginCell().storeUint(0,32).storeStringTail('Hello, TON!').endCell().toBoc()
  assert.equal(commentPayloadBoc('Hello, TON!'), 'te6cckEBAQEAEQAAHgAAAABIZWxsbywgVE9OIb7WCx4=');
  assert.equal(decodeCommentBoc(commentPayloadBoc('DS-7K2QH9XA')), 'DS-7K2QH9XA');
  assert.throws(() => commentPayloadBoc('x'.repeat(124)));
});

test('TON price is the Stars price minus the web discount, rounded up to 0.01 TON', () => {
  const cfg = makeCfg();
  const book = { launch_stars: 300, full_stars: 450, launch_ends_at: null };
  assert.equal(starsPrice(book), 450);
  assert.equal(tonPriceNano(book, cfg), 1_980_000_000n); // 450 * 0.005 * 0.88 = 1.98
  assert.equal(formatTon(tonPriceNano(book, cfg)), '1.98');
  const launching = { ...book, launch_ends_at: Math.floor(Date.now() / 1000) + 3600 };
  assert.equal(formatTon(tonPriceNano(launching, cfg)), '1.32'); // 300 * 0.005 * 0.88
  assert.ok(tonPriceNano(book, cfg) < BigInt(450 * 0.005 * 1e9), 'web is cheaper than the Stars equivalent');
});

test('reads comments from both toncenter message shapes', () => {
  assert.equal(inMsgComment({ message: 'DS-ABCDEFGH' }), 'DS-ABCDEFGH');
  assert.equal(inMsgComment({ message: '', msg_data: { '@type': 'msg.dataText', text: Buffer.from('DS-ABCDEFGH').toString('base64') } }), 'DS-ABCDEFGH');
  assert.equal(inMsgComment(null), '');
});

function toncenterFake(pages) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const u = new URL(url);
    const lt = u.searchParams.get('lt');
    const result = lt ? (pages[lt] || []) : pages.first;
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { fetchImpl, requests };
}
let lt = 1000;
const tx = (comment, value, source = 'EQsender') => {
  lt += 1;
  return { transaction_id: { lt: String(lt), hash: `hash${lt}` }, utime: 0, in_msg: { source, destination: 'UQTESTRECEIVER', value: String(value), message: comment } };
};

test('watcher settles matching orders, flags underpayments and ignores noise', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const events = [];
  const good = db.createTonOrder({ bookId: 'first-ai-workflow', amountNano: 660_000_000n, ttlMinutes: 30 }).order;
  const low = db.createTonOrder({ bookId: 'ai-control-center', amountNano: 1_980_000_000n, ttlMinutes: 30 }).order;
  const txs = [
    tx(low.id, '1000000000'),
    tx('hello', '5'),
    tx(good.id.toLowerCase(), '700000000'), // case-insensitive, overpaid is fine
    tx('DS-ZZZZZZZZ', '1'),
    tx(good.id, '0', ''), // external/no source: ignored
  ].reverse(); // toncenter returns newest first
  const { fetchImpl, requests } = toncenterFake({ first: txs });
  const w = createWatcher({ db, cfg, fetchImpl, log: silentLog, onEvent: async (e) => events.push(e) });

  const r = await w.pollOnce();
  assert.equal(r.processed, 5);
  assert.equal(db.getTonOrder(good.id).status, 'paid');
  assert.equal(db.getTonOrder(good.id).received_nano, '700000000');
  assert.equal(db.getTonOrder(low.id).status, 'underpaid');
  assert.deepEqual(events.map((e) => e.type).sort(), ['paid', 'underpaid', 'unknown_order']);
  assert.match(requests[0], /^https:\/\/testnet\.toncenter\.com\/api\/v2\/getTransactions\?address=UQTESTRECEIVER/);
  const purchase = db.raw.prepare('SELECT * FROM purchases WHERE order_id = ?').get(good.id);
  assert.equal(purchase.method, 'ton');
  assert.ok(purchase.tx_hash);

  // second poll: same transactions are already seen -> nothing new
  db.createTonOrder({ bookId: 'first-ai-workflow', amountNano: 1n, ttlMinutes: 30 }); // keep watcher active
  const r2 = await w.pollOnce();
  assert.equal(r2.processed, 0);
});

test('watcher pages back until it reaches a seen transaction', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const order = db.createTonOrder({ bookId: 'first-ai-workflow', amountNano: 1n, ttlMinutes: 30 }).order;
  const seen = tx('old', '1');
  db.markTxSeen(seen.transaction_id.hash, seen.transaction_id.lt);
  const older = [seen, tx(order.id, '10'), ...Array.from({ length: 47 }, () => tx('noise', '1'))].reverse(); // 49, newest first
  const newest = Array.from({ length: 50 }, () => tx('noise', '1')).reverse();
  const cursorLt = newest.at(-1).transaction_id.lt;
  // toncenter's next page starts with the cursor transaction itself (50 rows total)
  const { fetchImpl, requests } = toncenterFake({ first: newest, [cursorLt]: [newest.at(-1), ...older] });
  const w = createWatcher({ db, cfg, fetchImpl, log: silentLog });
  const r = await w.pollOnce();
  assert.equal(requests.length, 2);
  assert.equal(r.processed, 50 + 48);
  assert.equal(db.getTonOrder(order.id).status, 'paid');
});

test('a late payment on an expired order is still credited', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const order = db.createTonOrder({ bookId: 'first-ai-workflow', amountNano: 5n, ttlMinutes: -1 }).order;
  const { fetchImpl } = toncenterFake({ first: [] });
  const w = createWatcher({ db, cfg, fetchImpl, log: silentLog });
  await w.pollOnce();
  assert.equal(db.getTonOrder(order.id).status, 'expired');
  const late = toncenterFake({ first: [tx(order.id, '5')] });
  const w2 = createWatcher({ db, cfg, fetchImpl: late.fetchImpl, log: silentLog });
  await w2.pollOnce();
  assert.equal(db.getTonOrder(order.id).status, 'paid');
});

test('watcher skips the API when no orders are open', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const { fetchImpl, requests } = toncenterFake({ first: [] });
  await createWatcher({ db, cfg, fetchImpl, log: silentLog }).pollOnce();
  assert.equal(requests.length, 0);
});
