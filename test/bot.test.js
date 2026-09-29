import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, user, textUpdate, callbackUpdate, buyWithStars } from './helpers.js';
import { COMMANDS } from '../src/bot/bot.js';

const buttons = (call) => call.params.reply_markup.inline_keyboard.flat();

test('exactly the seven specified commands are registered', () => {
  assert.deepEqual(COMMANDS.map((c) => c.command), ['start', 'shelf', 'sample', 'library', 'invite', 'help', 'paysupport']);
});

test('/start welcomes with the three main buttons and creates the user', async () => {
  const app = await makeApp();
  const u = user(1);
  await app.bot.handleUpdate(textUpdate(u, '/start'));
  const welcome = app.api.of('sendMessage')[0];
  assert.deepEqual(buttons(welcome).map((b) => b.text), ['📖 Get a free chapter', '📚 Browse the shelf', '🗂 My library']);
  const profile = app.store.getUserProfile(1);
  assert.equal(profile.telegram_user_id, 1);
  assert.match(profile.referral_code, /^[A-Z2-9]{8}$/);
  assert.equal(profile.alert_opt_in, false);
  assert.deepEqual(profile.purchases, []);
});

test('/start deep links: sample, buy_<slug>, ref_<code> are handled and logged', async () => {
  const app = await makeApp();
  await app.bot.handleUpdate(textUpdate(user(1), '/start'));
  const code = app.store.getUser(1).referral_code;

  await app.bot.handleUpdate(textUpdate(user(2), `/start ref_${code}`));
  assert.equal(app.store.getUser(2).referrer_id, 1);

  // Existing users can't be re-attributed, and self-referral is ignored.
  await app.bot.handleUpdate(textUpdate(user(2), '/start ref_XXXXXXXX'));
  assert.equal(app.store.getUser(2).referrer_id, 1);
  await app.bot.handleUpdate(textUpdate(user(3), `/start ref_${app.store.getUser(3)?.referral_code || 'NONE'}`));
  assert.equal(app.store.getUser(3).referrer_id, null);

  await app.bot.handleUpdate(textUpdate(user(4), '/start buy_ai-control-center'));
  assert.equal(app.api.of('sendInvoice').at(-1).params.chat_id, 4);

  await app.bot.handleUpdate(textUpdate(user(5), '/start sample_channel'));
  assert.equal(app.store.getUser(5).alert_opt_in, 1);
  const events = app.db.prepare("SELECT data FROM events WHERE type = 'start'").all().map((r) => JSON.parse(r.data).payload);
  assert.ok(events.includes('sample_channel') && events.includes('buy_ai-control-center'));
});

test('/shelf lists active books, current drop first, with Buy and Free chapter buttons', async () => {
  const app = await makeApp();
  await app.bot.handleUpdate(textUpdate(user(1), '/shelf'));
  const items = app.api.of('sendMessage');
  assert.equal(items.length, 4);
  assert.match(items[0].params.text, /Current drop[\s\S]*Telegram as Your AI Control Center/);
  assert.match(items[0].params.text, /300 Stars<\/b> launch price/);
  assert.deepEqual(buttons(items[0]).map((b) => b.text), ['⭐ Buy · 300 Stars', '📖 Free chapter']);
  assert.match(items[1].params.text, /Automate Your Telegram Channel/);
  assert.match(items[2].params.text, /Zapier vs Make vs n8n/);
  assert.match(items[3].params.text, /Bundle/);

  app.store.setBookField('automate-channel-ai', 'active', 0);
  app.api.reset();
  await app.bot.handleUpdate(textUpdate(user(1), '/shelf'));
  assert.equal(app.api.of('sendMessage').length, 3);
});

test('/shelf uses the cover image when one exists', async () => {
  const app = await makeApp();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${app.config.storageDir}/covers/ai-control-center.jpg`, Buffer.from([0xff, 0xd8, 0xff]));
  await app.bot.handleUpdate(textUpdate(user(1), '/shelf'));
  const photo = app.api.of('sendPhoto')[0];
  assert.match(photo.params.caption, /AI Control Center/);
  assert.equal(buttons(photo)[0].callback_data, `buy:${app.store.getBookBySlug('ai-control-center').id}`);
});

test('/sample delivers the guide PDF and workflow JSON, and opts into drop alerts', async () => {
  const app = await makeApp();
  await app.bot.handleUpdate(textUpdate(user(1), '/sample'));
  const docs = app.api.of('sendDocument').map((c) => c.params.document.filename);
  assert.deepEqual(docs, ['ai-daily-brief.pdf', 'ai-daily-brief.workflow.json']);
  assert.equal(app.store.getUser(1).alert_opt_in, 1);
  const outro = app.api.of('sendMessage').at(-1);
  assert.match(buttons(outro)[0].text, /Buy the full book/);

  // Second time: cached file_ids are reused instead of re-uploading.
  app.api.reset();
  await app.bot.handleUpdate(textUpdate(user(2), '/sample'));
  assert.ok(app.api.of('sendDocument').every((c) => typeof c.params.document === 'string'));

  await app.bot.handleUpdate(callbackUpdate(user(1), 'alerts:off'));
  assert.equal(app.store.getUser(1).alert_opt_in, 0);
});

test('Stars checkout: XTR invoice, pre-checkout validation, delivery only after successful_payment', async () => {
  const app = await makeApp();
  const u = user(10);
  const book = app.store.getBookBySlug('ai-control-center');
  await app.bot.handleUpdate(callbackUpdate(u, `buy:${book.id}`));
  const inv = app.api.of('sendInvoice')[0].params;
  assert.equal(inv.currency, 'XTR');
  assert.equal(inv.provider_token, '');
  assert.deepEqual(inv.prices, [{ label: 'Telegram AI Control Center', amount: 300 }]);
  assert.ok(inv.title.length <= 32);
  assert.equal(app.api.of('sendDocument').length, 0, 'nothing delivered before payment');

  const pcq = (over) => app.bot.handleUpdate({ pre_checkout_query: { id: 'q', from: u, currency: 'XTR', total_amount: 300, invoice_payload: inv.payload, ...over } });
  await pcq({ total_amount: 1 });
  assert.equal(app.api.of('answerPreCheckoutQuery').at(-1).params.ok, false);
  await pcq({ from: user(11) });
  assert.equal(app.api.of('answerPreCheckoutQuery').at(-1).params.ok, false);
  await pcq({ currency: 'USD' });
  assert.equal(app.api.of('answerPreCheckoutQuery').at(-1).params.ok, false);
  await pcq({});
  assert.equal(app.api.of('answerPreCheckoutQuery').at(-1).params.ok, true);
  assert.equal(app.api.of('sendDocument').length, 0, 'still nothing delivered after pre-checkout');

  const pay = { message: { message_id: 5, from: u, chat: { id: 10, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: 300, invoice_payload: inv.payload, telegram_payment_charge_id: 'stxABC', provider_payment_charge_id: '' } } };
  await app.bot.handleUpdate(pay);
  const docs = app.api.of('sendDocument');
  assert.equal(docs.length, 2);
  assert.equal(docs[1].params.document.filename, 'ai-control-center.pdf');
  assert.ok(Buffer.isBuffer(docs[1].params.document.buffer), 'PDF is stamped per buyer');
  assert.ok(app.api.texts(10).some((t) => t.includes('Receipt') && t.includes('stxABC')));

  const profile = app.store.getUserProfile(10);
  assert.equal(profile.purchases.length, 1);
  assert.equal(profile.purchases[0].charge_id, 'stxABC');
  assert.equal(profile.purchases[0].stars_paid, 300);
  assert.equal(profile.purchases[0].method, 'stars');

  // Duplicate webhook delivery is idempotent.
  await app.bot.handleUpdate(pay);
  assert.equal(app.api.of('sendDocument').length, 2);
  assert.equal(app.store.getUserProfile(10).purchases.length, 1);

  // A second pre-checkout for an owned book is rejected.
  await app.bot.handleUpdate(callbackUpdate(u, `buy:${book.id}`));
  assert.ok(app.api.texts(10).at(-1).includes('already in your library'));
});

test('launch window: full price after launch_ends_at', async () => {
  const app = await makeApp();
  app.store.setBookField('ai-control-center', 'launch_ends_at', Date.now() - 1000);
  await app.bot.handleUpdate(callbackUpdate(user(1), `buy:${app.store.getBookBySlug('ai-control-center').id}`));
  assert.equal(app.api.of('sendInvoice')[0].params.prices[0].amount, 450);
});

test('bundle purchase unlocks all three books', async () => {
  const app = await makeApp();
  await buyWithStars(app, user(20), 'drop-shelf-bundle');
  assert.equal(app.api.of('sendInvoice')[0].params.prices[0].amount, 600);
  assert.equal(app.store.libraryBooks(20).length, 3);
  assert.equal(app.api.of('sendDocument').length, 6);
});

test('/library lists purchases with EPUB and PDF buttons; re-download checks ownership', async () => {
  const app = await makeApp();
  const u = user(30);
  await app.bot.handleUpdate(textUpdate(u, '/library'));
  assert.match(app.api.texts(30).at(-1), /library is empty/);

  await buyWithStars(app, u, 'first-ai-workflow-weekend');
  app.api.reset();
  await app.bot.handleUpdate(textUpdate(u, '/library'));
  const lib = app.api.of('sendMessage')[0];
  const id = app.store.getBookBySlug('first-ai-workflow-weekend').id;
  assert.deepEqual(buttons(lib).map((b) => b.callback_data), [`dl:${id}:epub`, `dl:${id}:pdf`]);

  app.api.reset();
  await app.bot.handleUpdate(callbackUpdate(u, `dl:${id}:epub`));
  assert.equal(app.api.of('sendDocument').length, 1);

  const other = app.store.getBookBySlug('ai-control-center').id;
  app.api.reset();
  await app.bot.handleUpdate(callbackUpdate(u, `dl:${other}:pdf`));
  assert.equal(app.api.of('sendDocument').length, 0);
  assert.equal(app.api.of('answerCallbackQuery')[0].params.show_alert, true);
});

test('/invite shows the link and progress; 3 referred buyers unlock the free book once', async () => {
  const app = await makeApp();
  const referrer = user(40);
  await app.bot.handleUpdate(textUpdate(referrer, '/start'));
  const code = app.store.getUser(40).referral_code;

  for (const id of [41, 42]) {
    await app.bot.handleUpdate(textUpdate(user(id), `/start ref_${code}`));
    await buyWithStars(app, user(id), 'automate-channel-ai');
  }
  app.api.reset();
  await app.bot.handleUpdate(textUpdate(referrer, '/invite'));
  const invite = app.api.texts(40)[0];
  assert.match(invite, /https:\/\/t\.me\/YourShelfBot\?start=ref_/);
  assert.match(invite, /<b>2 of 3<\/b> referrals to your free book/);

  // A referred user who only starts (no purchase) does not count.
  await app.bot.handleUpdate(textUpdate(user(43), `/start ref_${code}`));
  assert.equal(app.store.qualifiedReferralCount(40), 2);

  await app.bot.handleUpdate(textUpdate(user(44), `/start ref_${code}`));
  await buyWithStars(app, user(44), 'ai-control-center');
  const reward = app.store.getBookBySlug('first-ai-workflow-weekend');
  assert.ok(app.store.ownedBookIds(40).has(reward.id));
  assert.ok(app.api.texts(40).some((t) => t.includes('You unlocked a free book')));

  // Fourth referral does not grant again.
  await app.bot.handleUpdate(textUpdate(user(45), `/start ref_${code}`));
  await buyWithStars(app, user(45), 'ai-control-center');
  assert.equal(app.store.getUserProfile(40).purchases.filter((p) => p.method === 'referral').length, 1);
});

test('/help shows FAQ, refund policy and a contact button', async () => {
  const app = await makeApp({ SUPPORT_CONTACT_URL: 'https://t.me/dropshelf_support' });
  await app.bot.handleUpdate(textUpdate(user(1), '/help'));
  const help = app.api.of('sendMessage')[0];
  assert.match(help.params.text, /Refund policy/);
  assert.equal(buttons(help)[0].url, 'https://t.me/dropshelf_support');
});

test('/paysupport opens a forum-topic thread and relays messages both ways', async () => {
  const app = await makeApp({ SUPPORT_USE_TOPICS: 'true' });
  const u = user(50);
  await buyWithStars(app, u, 'ai-control-center', 'stxSUPPORT');
  app.api.reset();

  await app.bot.handleUpdate(textUpdate(u, '/paysupport'));
  assert.equal(app.api.of('createForumTopic').length, 1);
  const header = app.api.of('sendMessage').find((c) => c.params.chat_id === '-100500');
  assert.equal(header.params.message_thread_id, 77);
  assert.match(header.params.text, /stxSUPPORT/);
  assert.match(app.api.texts(50).at(-1), /ticket #1/);

  // User message goes to the topic.
  await app.bot.handleUpdate(textUpdate(u, 'I paid but the PDF did not arrive'));
  const copy = app.api.of('copyMessage').at(-1).params;
  assert.equal(copy.chat_id, '-100500');
  assert.equal(copy.message_thread_id, 77);

  // Staff reply inside the topic goes back to the user.
  await app.bot.handleUpdate({ message: { message_id: 9, from: user(999), chat: { id: -100500, type: 'supergroup' }, is_topic_message: true, message_thread_id: 77, text: 'Resent it, check /library' } });
  assert.match(app.api.texts(50).at(-1), /Resent it/);

  await app.bot.handleUpdate(callbackUpdate(u, 'support:close'));
  assert.equal(app.store.openTicket(50), null);
  assert.equal(app.api.of('closeForumTopic').length, 1);
});

test('/paysupport without topics uses reply threads', async () => {
  const app = await makeApp();
  const u = user(51);
  await app.bot.handleUpdate(textUpdate(u, '/paysupport'));
  await app.bot.handleUpdate(textUpdate(u, 'charged twice'));
  const copiedId = app.api.calls.findLast((c) => c.method === 'copyMessage');
  const copyResultId = app.api.nextMessageId - 3; // copy result id precedes the label and the ack
  await app.bot.handleUpdate({ message: { message_id: 11, from: user(999), chat: { id: -100500, type: 'supergroup' }, reply_to_message: { message_id: copyResultId }, text: 'Refund issued' } });
  assert.ok(copiedId);
  assert.match(app.api.texts(51).at(-1), /Refund issued/);
});

test('refund goes through refundStarPayment with the stored charge id and removes the book', async () => {
  const app = await makeApp();
  await buyWithStars(app, user(60), 'automate-channel-ai', 'stxREFUND');
  await app.bot.refund('stxREFUND');
  const call = app.api.of('refundStarPayment')[0].params;
  assert.deepEqual(call, { user_id: 60, telegram_payment_charge_id: 'stxREFUND' });
  assert.equal(app.store.libraryBooks(60).length, 0);
  assert.match(app.api.texts(60).at(-1), /Refund confirmed/);
  await assert.rejects(app.bot.refund('stxREFUND'), /already refunded/);
});

test('the bot never mentions TON or links to the web checkout', async () => {
  const app = await makeApp({ CHANNEL_ID: '' });
  const u = user(70);
  for (const cmd of ['/start', '/shelf', '/sample', '/library', '/invite', '/help', '/paysupport']) {
    await app.bot.handleUpdate(textUpdate(u, cmd));
  }
  await buyWithStars(app, u, 'ai-control-center');
  await app.bot.announceDrop(app.store.getBookBySlug('automate-channel-ai'), { webUrl: 'https://shop.example/book/x' });
  const payload = JSON.stringify(app.api.calls.filter((c) => c.params.chat_id === 70).map((c) => c.params));
  assert.doesNotMatch(payload, /\bTON\b|shop\.example|tonconnect/i);
});

test('drop announcement alerts opted-in users and posts to the channel with the web link', async () => {
  const app = await makeApp({ CHANNEL_ID: '@YourShelf' });
  await app.bot.handleUpdate(textUpdate(user(80), '/sample'));
  await app.bot.handleUpdate(textUpdate(user(81), '/start'));
  const book = app.store.startDrop('automate-channel-ai', 48);
  app.api.reset();
  const res = await app.bot.announceDrop(book, { webUrl: 'https://shop.example/book/automate-channel-ai' });
  assert.deepEqual(res, { sent: 1, failed: 0 });
  assert.equal(app.api.texts(81).length, 0);
  const post = app.api.of('sendMessage').find((c) => c.params.chat_id === '@YourShelf');
  assert.match(post.params.text, /@YourShelfBot/);
  assert.ok(buttons(post).some((b) => b.url === 'https://t.me/YourShelfBot?start=buy_automate-channel-ai'));
  assert.equal(app.store.activeBooks()[0].slug, 'automate-channel-ai');
});

test('staff close-ticket button only works from the support chat', async () => {
  const app = await makeApp();
  await app.bot.handleUpdate(textUpdate(user(52), '/paysupport'));
  const ticket = app.store.openTicket(52);
  await app.bot.handleUpdate(callbackUpdate(user(53), `tclose:${ticket.id}`));
  assert.ok(app.store.openTicket(52), 'a user outside the support chat cannot close tickets');
  await app.bot.handleUpdate({ callback_query: { id: 'x', from: user(999), data: `tclose:${ticket.id}`, message: { message_id: 1, chat: { id: -100500, type: 'supergroup' } } } });
  assert.equal(app.store.openTicket(52), null);
});
