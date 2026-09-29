import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot, encodeInvoicePayload } from '../src/bot/bot.js';
import { createWebServer } from '../src/web/server.js';
import { startPolling } from '../src/bot/updates.js';
import { makeCfg, makeDb, fakeApi, silentLog, paidUpdate } from './helpers.js';

const buyer = { id: 3001, first_name: 'Dana' };
const payload = encodeInvoicePayload('first-ai-workflow', 150);

test('a payment whose delivery fails is recorded, retried, and delivered on redelivery', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const failing = fakeApi({ fail: { sendDocument: new Error('upload timeout') } });
  const update = paidUpdate(buyer, { payload, amount: 150, charge: 'ch_retry' });

  await assert.rejects(createBot({ db, api: failing, cfg, log: silentLog }).handleUpdate(update), /upload timeout/);
  const p = db.getPurchaseByCharge('ch_retry');
  assert.ok(p, 'purchase recorded before delivery');
  assert.equal(p.delivered_at, null);

  const ok = fakeApi();
  await createBot({ db, api: ok, cfg, log: silentLog }).handleUpdate(update); // Telegram redelivers
  assert.equal(ok.of('sendDocument').length, 2);
  assert.ok(db.getPurchaseByCharge('ch_retry').delivered_at);

  await createBot({ db, api: ok, cfg, log: silentLog }).handleUpdate(update); // and again: no resend
  assert.equal(ok.of('sendDocument').length, 2);
  assert.equal(db.listPurchases(buyer.id).length, 1);
});

test('webhook returns 500 for a failed payment update so Telegram retries', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const bot = createBot({ db, api: fakeApi({ fail: { sendDocument: new Error('boom') } }), cfg, log: silentLog });
  const server = createWebServer({ db, cfg, bot, log: silentLog });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/tg/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': cfg.webhookSecret },
      body: JSON.stringify(paidUpdate(buyer, { payload, amount: 150, charge: 'ch_wh' })),
    });
    assert.equal(res.status, 500);
  } finally { await new Promise((r) => server.close(r)); }
});

test('poller refetches a payment update that failed instead of skipping it', async () => {
  const update = paidUpdate(buyer, { payload, amount: 150, charge: 'ch_poll' });
  const offsets = [];
  const abort = new AbortController();
  const api = {
    async call(method, params) {
      if (method !== 'getUpdates') return true;
      offsets.push(params.offset);
      if (offsets.length >= 3) abort.abort();
      return params.offset <= update.update_id ? [update] : [];
    },
  };
  let calls = 0;
  const bot = { async handleUpdate() { calls += 1; if (calls === 1) throw new Error('transient'); } };
  await startPolling({ api, bot, log: silentLog, signal: abort.signal });
  assert.equal(calls, 2, 'handled again after the failure');
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], 0, 'offset not advanced past the failed payment');
  assert.equal(offsets[2], update.update_id + 1);
});
