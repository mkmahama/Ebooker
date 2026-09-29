import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot, COMMANDS, parseStartPayload, decodeInvoicePayload, encodeInvoicePayload, REFUND_POLICY } from '../src/bot/bot.js';
import { makeCfg, makeDb, fakeApi, silentLog, msgUpdate, cbUpdate, preCheckoutUpdate, paidUpdate } from './helpers.js';

function setup(over = {}) {
  const cfg = makeCfg(over);
  const db = makeDb();
  const api = fakeApi();
  const bot = createBot({ db, api, cfg, log: silentLog });
  return { cfg, db, api, bot };
}
const alice = { id: 1001, first_name: 'Alice', username: 'alice' };
const bob = { id: 1002, first_name: 'Bob' };
const buttons = (call) => (call.params.reply_markup?.inline_keyboard || []).flat();

/** Buy flow helper: invoice -> pre-checkout -> successful_payment. Returns the invoice. */
async function buy(ctx, user, bookId, charge) {
  await ctx.bot.handleUpdate(cbUpdate(user, `buy:${bookId}`));
  const inv = ctx.api.of('sendInvoice').at(-1).params;
  await ctx.bot.handleUpdate(preCheckoutUpdate(user, { payload: inv.payload, amount: inv.prices[0].amount }));
  await ctx.bot.handleUpdate(paidUpdate(user, { payload: inv.payload, amount: inv.prices[0].amount, charge }));
  return inv;
}

test('registers exactly the seven commands', async () => {
  const { bot, api } = setup();
  await bot.registerCommands();
  const names = api.of('setMyCommands')[0].params.commands.map((c) => c.command);
  assert.deepEqual(names, ['start', 'shelf', 'sample', 'library', 'invite', 'help', 'paysupport']);
  assert.equal(COMMANDS.length, 7);
});

test('/start shows the three main buttons', async () => {
  const { bot, api, db } = setup();
  await bot.handleUpdate(msgUpdate(alice, '/start'));
  const labels = buttons(api.of('sendMessage')[0]).map((b) => b.text);
  assert.deepEqual(labels, ['🎁 Get a free chapter', '📚 Browse the shelf', '🗂 My library']);
  assert.ok(db.getUser(alice.id));
});

test('deep-link payload parsing', () => {
  assert.deepEqual(parseStartPayload('sample'), { kind: 'sample' });
  assert.deepEqual(parseStartPayload('sample_ai-control-center'), { kind: 'sample', bookId: 'ai-control-center' });
  assert.deepEqual(parseStartPayload('buy_first-ai-workflow'), { kind: 'buy', bookId: 'first-ai-workflow' });
  assert.deepEqual(parseStartPayload('ref_ABCD2345'), { kind: 'ref', code: 'ABCD2345' });
  assert.deepEqual(parseStartPayload('claim_ABCDEFGH2345'), { kind: 'claim', code: 'ABCDEFGH2345' });
  assert.equal(parseStartPayload('../etc').kind, 'unknown');
  assert.equal(parseStartPayload('').kind, 'none');
});

test('referral code attaches only to new users and never to yourself', async () => {
  const { bot, db } = setup();
  await bot.handleUpdate(msgUpdate(alice, '/start'));
  const code = db.getUser(alice.id).referral_code;
  await bot.handleUpdate(msgUpdate(alice, `/start ref_${code}`)); // self
  assert.equal(db.getUser(alice.id).referrer_id, null);
  await bot.handleUpdate(msgUpdate(bob, `/start ref_${code}`)); // new user
  assert.equal(db.getUser(bob.id).referrer_id, alice.id);
  assert.equal(db.getUser(bob.id).first_source, `ref_${code}`);
  const carol = { id: 1003, first_name: 'Carol' };
  await bot.handleUpdate(msgUpdate(carol, '/start'));
  await bot.handleUpdate(msgUpdate(carol, `/start ref_${code}`)); // existing user
  assert.equal(db.getUser(carol.id).referrer_id, null);
});

test('/start buy_<id> deep link sends a Stars invoice', async () => {
  const { bot, api } = setup();
  await bot.handleUpdate(msgUpdate(alice, '/start buy_ai-channel-automation'));
  const inv = api.of('sendInvoice')[0].params;
  assert.equal(inv.currency, 'XTR');
  assert.equal(inv.prices[0].amount, 300);
  assert.equal(inv.provider_token, undefined);
});

test('/shelf lists live books, current drop first, with Buy and Free chapter', async () => {
  const { bot, api, db } = setup();
  db.startLaunch('ai-control-center', 48);
  await bot.handleUpdate(msgUpdate(alice, '/shelf'));
  const msgs = api.of('sendMessage');
  assert.equal(msgs.length, 3);
  assert.match(msgs[0].params.text, /Current drop/);
  assert.match(msgs[0].params.text, /Telegram as Your AI Control Center/);
  assert.match(msgs[0].params.text, /300 Stars<\/b> launch price, 48h left \(then 450\)/);
  const labels = buttons(msgs[0]).map((b) => b.text);
  assert.deepEqual(labels, ['Buy · 300 ⭐', '🎁 Free chapter']);
});

test('invoices use XTR, titles fit the 32-char limit, launch vs full price', async () => {
  const { bot, api, db } = setup();
  for (const id of ['ai-control-center', 'ai-channel-automation', 'first-ai-workflow']) {
    await bot.handleUpdate(cbUpdate(alice, `buy:${id}`));
  }
  const invs = api.of('sendInvoice').map((c) => c.params);
  assert.deepEqual(invs.map((i) => i.prices[0].amount), [450, 300, 150]);
  for (const i of invs) {
    assert.equal(i.currency, 'XTR');
    assert.ok(i.title.length <= 32 && i.description.length <= 255 && Buffer.byteLength(i.payload) <= 128);
  }
  db.startLaunch('ai-control-center', 48);
  await bot.handleUpdate(cbUpdate(alice, 'buy:ai-control-center'));
  assert.equal(api.of('sendInvoice').at(-1).params.prices[0].amount, 300);
});

test('pre_checkout_query: accepts valid, rejects tampered, owned and stale invoices', async () => {
  const ctx = setup();
  const { bot, api, db } = ctx;
  const answer = () => api.of('answerPreCheckoutQuery').at(-1).params;

  await bot.handleUpdate(cbUpdate(alice, 'buy:ai-control-center'));
  const inv = api.of('sendInvoice').at(-1).params;
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: inv.payload, amount: 450 }));
  assert.equal(answer().ok, true);

  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: inv.payload, amount: 1 }));
  assert.equal(answer().ok, false);
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: inv.payload, amount: 450, currency: 'USD' }));
  assert.equal(answer().ok, false);
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: 'garbage', amount: 450 }));
  assert.equal(answer().ok, false);
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: encodeInvoicePayload('nope', 450), amount: 450 }));
  assert.equal(answer().ok, false);

  // launch-price invoice paid after the launch ended: honored within the grace hour, refused later
  const now = Math.floor(Date.now() / 1000);
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: encodeInvoicePayload('ai-control-center', 300, now - 600), amount: 300 }));
  assert.equal(answer().ok, true);
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: encodeInvoicePayload('ai-control-center', 300, now - 7200), amount: 300 }));
  assert.equal(answer().ok, false);
  assert.match(answer().error_message, /price has changed/);

  await buy(ctx, alice, 'first-ai-workflow', 'ch_owned');
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: encodeInvoicePayload('first-ai-workflow', 150), amount: 150 }));
  assert.equal(answer().ok, false);
  assert.match(answer().error_message, /already own/);

  db.setBookStatus('ai-channel-automation', 'hidden');
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: encodeInvoicePayload('ai-channel-automation', 300), amount: 300 }));
  assert.equal(answer().ok, false);
});

test('files are delivered only after successful_payment; charge_id stored; retries are idempotent', async () => {
  const ctx = setup();
  const { bot, api, db } = ctx;
  await bot.handleUpdate(cbUpdate(alice, 'buy:ai-control-center'));
  const inv = api.of('sendInvoice')[0].params;
  await bot.handleUpdate(preCheckoutUpdate(alice, { payload: inv.payload, amount: 450 }));
  assert.equal(api.of('sendDocument').length, 0, 'nothing delivered before payment');

  const paid = paidUpdate(alice, { payload: inv.payload, amount: 450, charge: 'ch_abc' });
  await bot.handleUpdate(paid);
  const docs = api.of('sendDocument');
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.params.document.filename), ['Telegram-as-Your-AI-Control-Center.epub', 'Telegram-as-Your-AI-Control-Center.pdf']);

  const u = db.getUserWithPurchases(alice.id);
  assert.equal(u.purchases.length, 1);
  assert.equal(u.purchases[0].charge_id, 'ch_abc');
  assert.equal(u.purchases[0].stars_paid, 450);
  assert.equal(u.purchases[0].book_id, 'ai-control-center');
  assert.ok(u.purchases[0].created_at > 0);

  await bot.handleUpdate(paid); // Telegram redelivers the same update
  assert.equal(api.of('sendDocument').length, 2);
  assert.equal(db.listPurchases(alice.id).length, 1);
});

test('a second paid copy (parallel invoices) is refunded automatically', async () => {
  const { bot, api, db } = setup();
  const payload = encodeInvoicePayload('first-ai-workflow', 150);
  await bot.handleUpdate(paidUpdate(alice, { payload, amount: 150, charge: 'ch_1' }));
  await bot.handleUpdate(paidUpdate(alice, { payload, amount: 150, charge: 'ch_2' }));
  const refunds = api.of('refundStarPayment');
  assert.equal(refunds.length, 1);
  assert.deepEqual(refunds[0].params, { user_id: alice.id, telegram_payment_charge_id: 'ch_2' });
  assert.equal(db.listPurchases(alice.id).length, 1);
  assert.ok(db.getPurchaseByCharge('ch_2').refunded_at);
});

test('uploads once, then re-sends by cached file_id', async () => {
  const ctx = setup();
  await buy(ctx, alice, 'first-ai-workflow', 'ch_1');
  await buy(ctx, bob, 'first-ai-workflow', 'ch_2');
  const docs = ctx.api.of('sendDocument').map((d) => d.params.document);
  assert.equal(typeof docs[0], 'object');
  assert.equal(typeof docs[2], 'string');
  assert.match(docs[2], /^FILE_/);
});

test('/library lists owned books; downloads require ownership', async () => {
  const ctx = setup();
  const { bot, api } = ctx;
  await bot.handleUpdate(msgUpdate(alice, '/library'));
  assert.match(api.of('sendMessage').at(-1).params.text, /empty/);

  await buy(ctx, alice, 'ai-channel-automation', 'ch_x');
  api.clear();
  await bot.handleUpdate(msgUpdate(alice, '/library'));
  const lib = api.of('sendMessage')[0];
  assert.deepEqual(buttons(lib).map((b) => b.callback_data), ['dl:ai-channel-automation:epub', 'dl:ai-channel-automation:pdf']);

  api.clear();
  await bot.handleUpdate(cbUpdate(alice, 'dl:ai-channel-automation:pdf'));
  assert.equal(api.of('sendDocument').length, 1);
  await bot.handleUpdate(cbUpdate(bob, 'dl:ai-channel-automation:pdf'));
  assert.equal(api.of('sendDocument').length, 1, 'bob does not own it');
  assert.match(api.of('answerCallbackQuery').at(-1).params.text, /not in your library/);
  await bot.handleUpdate(cbUpdate(alice, 'dl:ai-channel-automation:exe'));
  assert.equal(api.of('sendDocument').length, 1);
});

test('/sample sends the chapter + workflow JSON and opts into drop alerts', async () => {
  const { bot, api, db } = setup();
  await bot.handleUpdate(msgUpdate(alice, '/sample'));
  const files = api.of('sendDocument').map((d) => d.params.document.filename);
  assert.deepEqual(files, ['daily-brief-chapter.pdf', 'daily-brief-workflow.json']);
  assert.equal(db.getUserWithPurchases(alice.id).alert_opt_in, true);
  await bot.handleUpdate(cbUpdate(alice, 'alerts:off'));
  assert.equal(db.getUserWithPurchases(alice.id).alert_opt_in, false);
});

test('/invite shows the link and progress; 3 buying referrals earn the reward book', async () => {
  const ctx = setup();
  const { bot, api, db } = ctx;
  await bot.handleUpdate(msgUpdate(alice, '/invite'));
  const code = db.getUser(alice.id).referral_code;
  const inviteText = api.of('sendMessage').at(-1).params.text;
  assert.ok(inviteText.includes(`https://t.me/YourShelfBot?start=ref_${code}`));
  assert.match(inviteText, /0 of 3<\/b> referrals to your free book/);

  const friends = [2001, 2002, 2003].map((id) => ({ id, first_name: `F${id}` }));
  for (const f of friends) await bot.handleUpdate(msgUpdate(f, `/start ref_${code}`));
  await buy(ctx, friends[0], 'ai-control-center', 'r1');
  await buy(ctx, friends[1], 'ai-control-center', 'r2');
  api.clear();
  await bot.handleUpdate(msgUpdate(alice, '/invite'));
  assert.match(api.of('sendMessage').at(-1).params.text, /2 of 3<\/b>/);

  api.clear();
  await buy(ctx, friends[2], 'first-ai-workflow', 'r3');
  assert.ok(db.ownsBook(alice.id, 'first-ai-workflow'), 'reward granted');
  const toAlice = api.calls.filter((c) => c.params.chat_id === alice.id);
  assert.ok(toAlice.some((c) => c.method === 'sendDocument'), 'reward delivered');
  assert.equal(db.getUser(alice.id).referral_rewarded, 1);

  // a fourth referral does not grant again
  const f4 = { id: 2004 };
  await bot.handleUpdate(msgUpdate(f4, `/start ref_${code}`));
  await buy(ctx, f4, 'first-ai-workflow', 'r4');
  assert.equal(db.listPurchases(alice.id).length, 1);
});

test('/help has FAQ, refund policy, contact button, and never mentions TON', async () => {
  const { bot, api } = setup();
  await bot.handleUpdate(msgUpdate(alice, '/help'));
  const m = api.of('sendMessage')[0];
  assert.ok(m.params.text.includes(REFUND_POLICY));
  const b = buttons(m);
  assert.equal(b[0].url, 'https://t.me/ShelfSupport');
  assert.ok(b.some((x) => x.callback_data === 'ticket:open'));
});

test('no TON checkout or TON links anywhere in the bot', async () => {
  const ctx = setup();
  const { bot, api, db } = ctx;
  db.startLaunch('ai-control-center', 48);
  for (const t of ['/start', '/shelf', '/sample', '/library', '/invite', '/help', '/paysupport', 'hello']) {
    await bot.handleUpdate(msgUpdate(alice, t));
  }
  await buy(ctx, alice, 'ai-control-center', 'c1');
  const everything = JSON.stringify(api.calls.filter((c) => c.params.chat_id === alice.id));
  assert.doesNotMatch(everything, /\bTON\b|toncoin|tonkeeper|ton connect/i);
  assert.ok(!everything.includes('shop.test'), 'no link to the web checkout');
});

test('/paysupport opens a thread relayed both ways and closes', async () => {
  const ctx = setup();
  const { bot, api, db, cfg } = ctx;
  await buy(ctx, alice, 'first-ai-workflow', 'ch_help');
  api.clear();
  await bot.handleUpdate(msgUpdate(alice, '/paysupport'));
  const [header, userMsg] = api.of('sendMessage');
  assert.equal(header.params.chat_id, cfg.supportChatId);
  assert.match(header.params.text, /Ticket #1/);
  assert.match(header.params.text, /ch_help/);
  assert.match(userMsg.params.text, /ticket #1/);

  await bot.handleUpdate(msgUpdate(alice, '/paysupport')); // reuses the open ticket
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM support_tickets').get().n, 1);

  api.clear();
  await bot.handleUpdate(msgUpdate(alice, 'I paid but got nothing'));
  const relayed = api.of('sendMessage')[0];
  assert.equal(relayed.params.chat_id, cfg.supportChatId);
  assert.match(relayed.params.text, /#1 · Alice:\nI paid but got nothing/);

  // admin replies to the relayed message in the support chat
  const admin = { id: 9, first_name: 'Admin' };
  const relayedId = db.raw.prepare('SELECT support_message_id FROM support_relay ORDER BY rowid DESC LIMIT 1').get().support_message_id;
  api.clear();
  await bot.handleUpdate({ update_id: 1, message: { message_id: 5000, from: admin, chat: { id: Number(cfg.supportChatId), type: 'supergroup' }, text: 'Resent your files!', reply_to_message: { message_id: relayedId } } });
  assert.equal(api.of('sendMessage')[0].params.chat_id, alice.id);
  assert.match(api.of('sendMessage')[0].params.text, /Resent your files!/);

  api.clear();
  await bot.handleUpdate({ update_id: 2, message: { message_id: 5001, from: admin, chat: { id: Number(cfg.supportChatId), type: 'supergroup' }, text: '!close', reply_to_message: { message_id: 5000 } } });
  assert.equal(db.getOpenTicket(alice.id), null);
  assert.match(api.of('sendMessage')[0].params.text, /closed by our team/);

  api.clear();
  await bot.handleUpdate(msgUpdate(alice, 'still there?'));
  assert.notEqual(api.of('sendMessage')[0].params.chat_id, cfg.supportChatId, 'closed ticket no longer relays');
});

test('/paysupport gives each ticket its own forum topic when the support chat has topics', async () => {
  const ctx = setup();
  const { bot, api, db, cfg } = ctx;
  const call = api.call;
  api.call = async (method, params) => {
    const r = await call(method, params);
    return method === 'createForumTopic' ? { message_thread_id: 77, name: params.name } : r;
  };
  await bot.handleUpdate(msgUpdate(alice, '/paysupport'));
  assert.match(api.of('createForumTopic')[0].params.name, /^#1 · Alice/);
  const header = api.of('sendMessage')[0];
  assert.equal(header.params.chat_id, cfg.supportChatId);
  assert.equal(header.params.message_thread_id, 77);
  assert.match(header.params.text, /Write in this topic/);

  api.clear();
  await bot.handleUpdate(msgUpdate(alice, 'Charged twice'));
  assert.equal(api.of('sendMessage')[0].params.message_thread_id, 77);

  // Agents just write in the topic; no reply needed. Service messages are ignored.
  const inTopic = (id, extra) => ({
    update_id: id, message: { message_id: id, from: { id: 9, first_name: 'Admin' }, chat: { id: Number(cfg.supportChatId), type: 'supergroup' },
      is_topic_message: true, message_thread_id: 77, ...extra },
  });
  api.clear();
  await bot.handleUpdate(inTopic(6000, { forum_topic_edited: { name: 'x' } }));
  assert.equal(api.calls.length, 0);
  await bot.handleUpdate(inTopic(6001, { text: 'Refund issued' }));
  assert.equal(api.of('sendMessage')[0].params.chat_id, alice.id);
  assert.match(api.of('sendMessage')[0].params.text, /Refund issued/);

  api.clear();
  await bot.handleUpdate(inTopic(6002, { text: '!close' }));
  assert.equal(db.getOpenTicket(alice.id), null);
  assert.deepEqual(api.of('closeForumTopic')[0].params, { chat_id: cfg.supportChatId, message_thread_id: 77 });
});

test('/paysupport falls back to reply threads when topics are unavailable', async () => {
  const ctx = setup();
  const { bot, api, db } = ctx;
  const call = api.call;
  api.call = async (method, params) => {
    if (method === 'createForumTopic') { api.calls.push({ method, params }); throw new Error('Bad Request: the chat is not a forum'); }
    return call(method, params);
  };
  await bot.handleUpdate(msgUpdate(alice, '/paysupport'));
  const header = api.of('sendMessage')[0];
  assert.equal(header.params.message_thread_id, undefined);
  assert.match(header.params.text, /Reply to any message/);
  assert.equal(db.getOpenTicket(alice.id).thread_id, null);
});

test('invoice payload round trip', () => {
  const p = encodeInvoicePayload('ai-control-center', 450, 1800000000);
  assert.deepEqual(decodeInvoicePayload(p), { bookId: 'ai-control-center', price: 450, at: 1800000000 });
  assert.equal(decodeInvoicePayload('v1|x|y|z'), null);
});
