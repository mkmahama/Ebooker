import fs from 'node:fs';
import path from 'node:path';
import { starsPrice, isLaunchPrice, launchHoursLeft } from '../pricing.js';
import { bookFile, coverFile, bookSampleFile, leadMagnetFiles, downloadName, FORMATS } from '../content.js';

/** The seven public commands, registered with setMyCommands. */
export const COMMANDS = [
  { command: 'start', description: 'Welcome and main menu' },
  { command: 'shelf', description: 'Browse books on sale' },
  { command: 'sample', description: 'Get the free chapter + n8n workflow' },
  { command: 'library', description: 'Re-download your books' },
  { command: 'invite', description: 'Your referral link and progress' },
  { command: 'help', description: 'FAQ, refunds and contact' },
  { command: 'paysupport', description: 'Help with a payment' },
];

export const REFUND_POLICY =
  'Refunds: if a book is not what its description promised, open /paysupport within 48 hours of buying ' +
  'and we will refund your Stars in full. Refunded books are removed from your library.';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });
const INVOICE_GRACE_SECONDS = 3600; // an invoice keeps its quoted price for an hour

export function encodeInvoicePayload(bookId, price, at = Math.floor(Date.now() / 1000)) {
  return `v1|${bookId}|${price}|${at}`;
}
export function decodeInvoicePayload(s) {
  const parts = String(s || '').split('|');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const price = Number(parts[2]);
  const at = Number(parts[3]);
  if (!/^[a-z0-9-]+$/.test(parts[1]) || !Number.isInteger(price) || !Number.isInteger(at)) return null;
  return { bookId: parts[1], price, at };
}

/** Parse a /start deep-link payload. */
export function parseStartPayload(p) {
  const s = String(p || '').trim();
  if (!s) return { kind: 'none' };
  if (s === 'sample') return { kind: 'sample' };
  if (s === 'shelf') return { kind: 'shelf' };
  if (s === 'library') return { kind: 'library' };
  let m;
  if ((m = s.match(/^sample_([a-z0-9-]{1,48})$/))) return { kind: 'sample', bookId: m[1] };
  if ((m = s.match(/^buy_([a-z0-9-]{1,48})$/))) return { kind: 'buy', bookId: m[1] };
  if ((m = s.match(/^ref_([A-Z0-9]{4,16})$/))) return { kind: 'ref', code: m[1] };
  if ((m = s.match(/^claim_([A-Z0-9]{8,16})$/))) return { kind: 'claim', code: m[1] };
  return { kind: 'unknown', raw: s };
}

export function createBot({ db, api, cfg, log = console }) {
  const call = (m, p) => api.call(m, p);
  const send = (chatId, text, extra = {}) =>
    call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const mainMenu = () => ({
    inline_keyboard: [
      [btn('🎁 Get a free chapter', 'sample')],
      [btn('📚 Browse the shelf', 'shelf')],
      [btn('🗂 My library', 'library')],
    ],
  });
  const isSupportChat = (chatId) => cfg.supportChatId && String(chatId) === String(cfg.supportChatId);

  // ---------- file delivery (uploads once, then reuses Telegram's file_id) ----------
  async function sendFile(chatId, filePath, { filename, caption } = {}) {
    const stat = fs.statSync(filePath);
    const cached = db.getCachedFileId(filePath, stat.mtimeMs);
    if (cached) {
      try {
        return await call('sendDocument', { chat_id: chatId, document: cached, caption, parse_mode: 'HTML' });
      } catch (e) {
        log.warn?.(`cached file_id rejected for ${filePath}, re-uploading: ${e.message}`);
      }
    }
    const msg = await call('sendDocument', {
      chat_id: chatId, document: { file: filePath, filename: filename || path.basename(filePath) }, caption, parse_mode: 'HTML',
    });
    if (msg?.document?.file_id) db.cacheFileId(filePath, stat.mtimeMs, msg.document.file_id);
    return msg;
  }

  async function deliverBook(chatId, book, formats = FORMATS) {
    const missing = [];
    for (const f of formats) {
      const p = bookFile(cfg, book.id, f);
      if (!fs.existsSync(p)) { missing.push(f); continue; }
      await sendFile(chatId, p, { filename: downloadName(book, f), caption: `<b>${esc(book.title)}</b> · ${f.toUpperCase()}` });
    }
    if (missing.length) {
      log.error?.(`missing files for ${book.id}: ${missing.join(', ')}`);
      await send(chatId, 'Your purchase is saved in /library, but a file is being prepared. We have been notified and will send it shortly.');
      await notifySupport(`⚠️ Missing ${missing.join(', ')} for <b>${esc(book.id)}</b> (buyer chat ${chatId}).`);
    }
    return missing.length === 0;
  }

  async function notifySupport(text, extra = {}) {
    if (!cfg.supportChatId) return null;
    try { return await send(cfg.supportChatId, text, extra); } catch (e) { log.error?.(`support notify failed: ${e.message}`); return null; }
  }

  /** Thread params for a ticket: its forum topic if it has one, otherwise the main support chat. */
  const inThread = (ticket) => (ticket?.thread_id ? { message_thread_id: ticket.thread_id } : {});

  /**
   * Give a new ticket its own forum topic when SUPPORT_CHAT_ID is a forum supergroup
   * (bot needs "Manage topics"). Without topics, tickets fall back to reply threads.
   */
  async function openTicketTopic(ticket, from) {
    try {
      const name = `#${ticket.id} · ${from.first_name || from.username || from.id}`.slice(0, 128);
      const topic = await call('createForumTopic', { chat_id: cfg.supportChatId, name });
      if (topic?.message_thread_id) {
        db.setTicketThread(ticket.id, topic.message_thread_id);
        return db.getTicket(ticket.id);
      }
    } catch (e) {
      log.info?.(`createForumTopic unavailable (${e.message}); using reply threads`);
    }
    return ticket;
  }

  async function closeTicketTopic(ticket) {
    if (!ticket?.thread_id || !cfg.supportChatId) return;
    await call('closeForumTopic', { chat_id: cfg.supportChatId, message_thread_id: ticket.thread_id })
      .catch((e) => log.warn?.(`closeForumTopic failed: ${e.message}`));
  }

  // ---------- screens ----------
  async function showWelcome(chatId, user) {
    await send(chatId,
      `Hi${user.first_name ? ` ${esc(user.first_name)}` : ''}! Welcome to <b>Drop Shelf</b>: short, tested guides for ` +
      'AI and workflow automation you can run from Telegram.\n\n' +
      'Start with the free chapter: an <b>AI daily brief</b> n8n workflow, ready to import.',
      { reply_markup: mainMenu() });
  }

  function priceLine(book) {
    const price = starsPrice(book);
    if (isLaunchPrice(book)) {
      return `⭐ <b>${price} Stars</b> launch price, ${launchHoursLeft(book)}h left (then ${book.full_stars})`;
    }
    return `⭐ <b>${price} Stars</b>`;
  }

  async function showShelf(chatId, userId) {
    const books = db.listLiveBooks();
    if (!books.length) return send(chatId, 'The shelf is being restocked. Turn on drop alerts with /sample to hear first.');
    for (const book of books) {
      const owned = db.ownsBook(userId, book.id);
      const header = book.featured ? '🔥 <b>Current drop</b>\n' : '';
      const caption = `${header}<b>${esc(book.title)}</b>\n${esc(book.pitch)}\n\n${owned ? '✅ In your library' : priceLine(book)}`;
      const keyboard = {
        inline_keyboard: [[
          owned ? btn('⬇️ Download', `dl:${book.id}:pdf`) : btn(`Buy · ${starsPrice(book)} ⭐`, `buy:${book.id}`),
          btn('🎁 Free chapter', `sample:${book.id}`),
        ]],
      };
      const cover = coverFile(cfg, book.id);
      if (cover) {
        await call('sendPhoto', { chat_id: chatId, photo: { file: cover }, caption, parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await send(chatId, caption, { reply_markup: keyboard });
      }
    }
  }

  async function sendSample(chatId, userId, bookId) {
    let files = [];
    let intro = '🎁 <b>Free chapter: AI daily brief to your Telegram</b>\nImport the JSON into n8n, add your credentials, and your first brief arrives in about 20 minutes.';
    if (bookId) {
      const book = db.getBook(bookId);
      const sample = book && bookSampleFile(cfg, bookId);
      if (sample) {
        files = [sample];
        intro = `🎁 <b>Free chapter from ${esc(book.title)}</b>`;
      }
    }
    if (!files.length) files = leadMagnetFiles(cfg);
    if (!files.length) {
      await notifySupport('⚠️ Lead magnet files are missing from content/sample/.');
      return send(chatId, 'The free chapter is being updated. Please try again in a little while.');
    }
    const wasOptedIn = !!db.getUser(userId)?.alert_opt_in;
    db.setAlertOptIn(userId, true);
    await send(chatId, intro);
    for (const f of files) await sendFile(chatId, f);
    await send(chatId,
      (wasOptedIn ? '' : '🔔 You are on the drop alert list; we will message you when a new book launches. ') +
      'Liked it? The full book has 8–10 workflows like this one.',
      { reply_markup: { inline_keyboard: [[btn('📚 See the books', 'shelf')], [btn('🔕 Stop drop alerts', 'alerts:off')]] } });
  }

  async function showLibrary(chatId, userId) {
    const purchases = db.listPurchases(userId);
    if (!purchases.length) {
      return send(chatId, 'Your library is empty for now.', { reply_markup: { inline_keyboard: [[btn('📚 Browse the shelf', 'shelf')]] } });
    }
    const rows = purchases.map((p) => [btn(`📘 ${p.title.slice(0, 28)} · EPUB`, `dl:${p.book_id}:epub`), btn('PDF', `dl:${p.book_id}:pdf`)]);
    return send(chatId, `🗂 <b>Your library</b> (${purchases.length})\nTap a format to download again.`, { reply_markup: { inline_keyboard: rows } });
  }

  async function showInvite(chatId, userId) {
    const user = db.getUser(userId);
    const link = `https://t.me/${cfg.botUsername}?start=ref_${user.referral_code}`;
    const qualified = db.countQualifiedReferrals(userId);
    const joined = db.countReferredUsers(userId);
    const reward = db.getBook(cfg.referralRewardBookId);
    const progress = user.referral_rewarded
      ? '🏆 You earned your free book. Thanks for spreading the word!'
      : `📈 <b>${Math.min(qualified, cfg.referralGoal)} of ${cfg.referralGoal}</b> referrals to your free book` +
        (reward ? ` (<i>${esc(reward.title)}</i>)` : '') + `.\n${joined} friend(s) joined through your link; a referral counts once they buy.`;
    return send(chatId, `🔗 <b>Your invite link</b>\n${link}\n\n${progress}`, {
      reply_markup: { inline_keyboard: [[urlBtn('📤 Share link', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Free AI automation chapter + n8n workflow:')}`)]] },
    });
  }

  async function showHelp(chatId, userId) {
    const user = db.getUser(userId);
    const text =
      '❓ <b>Help</b>\n\n' +
      '<b>How do I pay?</b> With Telegram Stars, right in this chat. Your files arrive as soon as the payment clears.\n' +
      '<b>What formats?</b> Every book comes as EPUB and PDF. Workflow books include importable n8n JSON.\n' +
      '<b>Lost a file?</b> /library re-sends anything you own.\n' +
      '<b>Book updates?</b> When tools change, updated editions land in your library for free.\n\n' +
      `${REFUND_POLICY}`;
    const keyboard = [
      [btn('💳 Payment problem', 'ticket:open')],
      [user?.alert_opt_in ? btn('🔕 Stop drop alerts', 'alerts:off') : btn('🔔 Turn on drop alerts', 'alerts:on')],
    ];
    keyboard.unshift([cfg.supportUsername ? urlBtn('✉️ Contact us', `https://t.me/${cfg.supportUsername}`) : btn('✉️ Contact us', 'ticket:open')]);
    return send(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }

  // ---------- Stars checkout ----------
  async function sendBookInvoice(chatId, userId, bookId) {
    const book = db.getBook(bookId);
    if (!book || book.status !== 'live') return send(chatId, 'That book is not on sale right now.', { reply_markup: mainMenu() });
    if (db.ownsBook(userId, bookId)) {
      return send(chatId, `✅ <b>${esc(book.title)}</b> is already in your library.`, {
        reply_markup: { inline_keyboard: [[btn('EPUB', `dl:${book.id}:epub`), btn('PDF', `dl:${book.id}:pdf`)]] },
      });
    }
    const price = starsPrice(book);
    return call('sendInvoice', {
      chat_id: chatId,
      title: book.invoice_title,
      description: book.description,
      payload: encodeInvoicePayload(book.id, price),
      currency: 'XTR',
      prices: [{ label: book.invoice_title, amount: price }],
    });
  }

  /** Must answer within 10 seconds; everything here is a local DB lookup. */
  async function onPreCheckout(q) {
    const reject = (error_message) => call('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: false, error_message });
    const p = decodeInvoicePayload(q.invoice_payload);
    if (!p || q.currency !== 'XTR') return reject('This invoice is not valid. Please open /shelf and try again.');
    const book = db.getBook(p.bookId);
    if (!book || book.status !== 'live') return reject('This book is no longer on sale.');
    if (q.total_amount !== p.price) return reject('The price on this invoice is not valid. Please request a new one from /shelf.');
    const current = starsPrice(book);
    const fresh = Math.floor(Date.now() / 1000) - p.at <= INVOICE_GRACE_SECONDS;
    const known = p.price === book.launch_stars || p.price === book.full_stars;
    if (p.price !== current && !(fresh && known)) return reject('The price has changed. Please request a new invoice from /shelf.');
    if (db.ownsBook(q.from.id, book.id)) return reject('You already own this book. Find it in /library.');
    return call('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: true });
  }

  /** Files go out only here, after Telegram confirms the payment. */
  async function onSuccessfulPayment(msg) {
    const sp = msg.successful_payment;
    const userId = msg.from.id;
    const p = decodeInvoicePayload(sp.invoice_payload);
    const book = p && db.getBook(p.bookId);
    if (sp.currency !== 'XTR' || !book) {
      log.error?.(`unrecognized payment ${sp.telegram_payment_charge_id}`, sp);
      await notifySupport(`⚠️ Unrecognized payment from ${userId}: charge <code>${esc(sp.telegram_payment_charge_id)}</code>`);
      return send(msg.chat.id, 'Payment received, but we could not match it to a book. Our team has been notified; use /paysupport if you need us sooner.');
    }
    db.upsertUser(msg.from);
    const { purchase, duplicate, alreadyOwned } = db.recordStarsPurchase({
      userId, bookId: book.id, stars: sp.total_amount, chargeId: sp.telegram_payment_charge_id,
    });
    if (duplicate) {
      // Telegram redelivered the update. Resend only if the files never went out (e.g. a crash mid-upload).
      if (purchase.delivered_at || purchase.refunded_at) return null;
      if (await deliverBook(msg.chat.id, book)) db.markDelivered(purchase.id);
      return null;
    }
    if (alreadyOwned) {
      try {
        await call('refundStarPayment', { user_id: userId, telegram_payment_charge_id: sp.telegram_payment_charge_id });
        return send(msg.chat.id, `You already owned <b>${esc(book.title)}</b>, so we refunded this payment. Find it in /library.`);
      } catch (e) {
        await notifySupport(`⚠️ Duplicate purchase refund failed for ${userId}, charge <code>${esc(sp.telegram_payment_charge_id)}</code>: ${esc(e.message)}`);
        return send(msg.chat.id, 'You already owned this book. We will refund this payment shortly.');
      }
    }
    await send(msg.chat.id, `🎉 Thanks! <b>${esc(book.title)}</b> is yours. Files below; it is also saved in /library.`);
    if (await deliverBook(msg.chat.id, book)) db.markDelivered(purchase.id);
    await checkReferralReward(userId).catch((e) => log.error?.(`referral check failed: ${e.message}`));
    return null;
  }

  // ---------- referrals ----------
  async function checkReferralReward(buyerId) {
    const buyer = db.getUser(buyerId);
    if (!buyer?.referrer_id) return;
    const referrer = db.getUser(buyer.referrer_id);
    if (!referrer || referrer.referral_rewarded) return;
    const qualified = db.countQualifiedReferrals(referrer.telegram_user_id);
    if (qualified < cfg.referralGoal) {
      try {
        await send(referrer.telegram_user_id, `🙌 A friend you invited just bought a book: <b>${qualified} of ${cfg.referralGoal}</b> toward your free book.`);
      } catch { /* user may have blocked the bot */ }
      return;
    }
    if (!db.markReferralRewarded(referrer.telegram_user_id)) return;
    const candidates = [db.getBook(cfg.referralRewardBookId), ...db.listLiveBooks().sort((a, b) => a.full_stars - b.full_stars)]
      .filter(Boolean);
    const reward = candidates.find((b) => !db.ownsBook(referrer.telegram_user_id, b.id));
    try {
      if (!reward) {
        await send(referrer.telegram_user_id, '🏆 You hit your referral goal, and you already own every book. Thank you!');
        return;
      }
      db.grantBook({ userId: referrer.telegram_user_id, bookId: reward.id, method: 'referral' });
      await send(referrer.telegram_user_id, `🏆 ${cfg.referralGoal} friends bought through your link. <b>${esc(reward.title)}</b> is yours, free.`);
      await deliverBook(referrer.telegram_user_id, reward);
    } catch (e) {
      log.error?.(`referral reward delivery failed: ${e.message}`);
    }
  }

  // ---------- /paysupport threads ----------
  async function openSupport(chatId, from) {
    let { ticket, created } = db.openTicket(from.id);
    if (created && cfg.supportChatId) ticket = await openTicketTopic(ticket, from);
    if (created) {
      const purchases = db.listPurchases(from.id).slice(0, 5)
        .map((p) => `• ${esc(p.book_id)} · ${p.method}${p.charge_id ? ` · <code>${esc(p.charge_id)}</code>` : ''}`).join('\n');
      const header = await notifySupport(
        `🎫 <b>Ticket #${ticket.id}</b> from ${esc(from.first_name || '')}${from.username ? ` @${esc(from.username)}` : ''} (id <code>${from.id}</code>)\n` +
        `${purchases || 'No purchases on file.'}\n\n` +
        (ticket.thread_id
          ? 'Write in this topic to answer. Send <code>!close</code> here to close it.'
          : 'Reply to any message of this ticket to answer. Reply <code>!close</code> to close it.'),
        inThread(ticket));
      if (header) db.linkRelay(header.message_id, ticket.id);
    }
    return send(chatId,
      `💳 <b>Payment support, ticket #${ticket.id}</b>\n` +
      'Tell us what happened: which book, roughly when you paid, and what you see. Screenshots help. ' +
      'Everything you send here goes to our team until you close the ticket.',
      { reply_markup: { inline_keyboard: [[btn('✅ Close ticket', 'ticket:close')]] } });
  }

  async function relayToSupport(msg, ticket) {
    if (!cfg.supportChatId) return send(msg.chat.id, 'Support is offline right now. Please try again later.');
    const who = `#${ticket.id} · ${esc(msg.from.first_name || msg.from.id)}`;
    let sent;
    if (msg.text) {
      sent = await send(cfg.supportChatId, `${who}:\n${esc(msg.text)}`, inThread(ticket));
    } else {
      await send(cfg.supportChatId, `${who} sent:`, inThread(ticket));
      sent = await call('copyMessage', { chat_id: cfg.supportChatId, from_chat_id: msg.chat.id, message_id: msg.message_id, ...inThread(ticket) });
    }
    if (sent?.message_id) db.linkRelay(sent.message_id, ticket.id);
    return null;
  }

  const TOPIC_SERVICE_KEYS = ['forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened'];

  async function onSupportChatMessage(msg) {
    if (TOPIC_SERVICE_KEYS.some((k) => msg[k])) return null; // topic created/closed notices, not agent replies
    const replyTo = msg.reply_to_message?.message_id;
    let ticket = null;
    if (msg.is_topic_message && msg.message_thread_id) ticket = db.getOpenTicketByThread(msg.message_thread_id);
    if (!ticket && replyTo) ticket = db.ticketForRelay(replyTo);
    if (!ticket) return null;
    const answerHere = { reply_parameters: { message_id: msg.message_id }, ...inThread(ticket) };
    if (msg.text?.trim().toLowerCase() === '!close') {
      if (db.closeTicket(ticket.id)) {
        await send(ticket.telegram_user_id, `✅ Ticket #${ticket.id} was closed by our team. Use /paysupport if you need us again.`);
      }
      await send(msg.chat.id, `Ticket #${ticket.id} closed.`, answerHere);
      return closeTicketTopic(ticket);
    }
    if (ticket.status !== 'open') {
      return send(msg.chat.id, `Ticket #${ticket.id} is closed; the user was not messaged.`, answerHere);
    }
    let sent;
    if (msg.text) {
      sent = await send(ticket.telegram_user_id, `💬 <b>Support (#${ticket.id}):</b>\n${esc(msg.text)}`);
    } else {
      sent = await call('copyMessage', { chat_id: ticket.telegram_user_id, from_chat_id: msg.chat.id, message_id: msg.message_id });
    }
    db.linkRelay(msg.message_id, ticket.id); // replies to the admin's own message stay in the thread
    return sent;
  }

  // ---------- TON order claims (web buyers adding a book to their library) ----------
  async function claimOrder(chatId, userId, code) {
    const r = db.claimTonOrder(code, userId);
    if (!r.ok) {
      const why = { not_found: 'That link is not valid.', not_paid: 'That order is not paid yet.', claimed: 'That order was already added to another account.' };
      return send(chatId, why[r.reason] || 'That link could not be used.', { reply_markup: mainMenu() });
    }
    const book = db.getBook(r.order.book_id);
    await send(chatId, r.already ? `✅ <b>${esc(book.title)}</b> is already in your library.` : `✅ <b>${esc(book.title)}</b> was added to your library.`);
    if (!r.already) {
      await deliverBook(chatId, book);
      await checkReferralReward(userId);
    }
    return null;
  }

  // ---------- routing ----------
  async function onStart(msg, payloadText) {
    const payload = parseStartPayload(payloadText);
    const source = payload.kind === 'none' ? null : payloadText.slice(0, 64);
    const { user, created } = db.upsertUser(msg.from, source);
    if (payload.kind === 'ref' && created) {
      const referrer = db.getUserByReferralCode(payload.code);
      if (referrer && referrer.telegram_user_id !== user.telegram_user_id) db.setReferrer(user.telegram_user_id, referrer.telegram_user_id);
    }
    switch (payload.kind) {
      case 'sample': return sendSample(msg.chat.id, user.telegram_user_id, payload.bookId);
      case 'buy':
        await showWelcome(msg.chat.id, user);
        return sendBookInvoice(msg.chat.id, user.telegram_user_id, payload.bookId);
      case 'shelf': return showShelf(msg.chat.id, user.telegram_user_id);
      case 'library': return showLibrary(msg.chat.id, user.telegram_user_id);
      case 'claim': return claimOrder(msg.chat.id, user.telegram_user_id, payload.code);
      default: return showWelcome(msg.chat.id, user);
    }
  }

  async function onCommand(msg) {
    const [head, ...rest] = msg.text.trim().split(/\s+/);
    const [cmd, mention] = head.slice(1).split('@');
    if (mention && mention.toLowerCase() !== cfg.botUsername.toLowerCase()) return null;
    const arg = rest.join(' ');
    if (cmd === 'start') return onStart(msg, arg);
    const { user } = db.upsertUser(msg.from);
    const uid = user.telegram_user_id;
    switch (cmd.toLowerCase()) {
      case 'shelf': return showShelf(msg.chat.id, uid);
      case 'sample': return sendSample(msg.chat.id, uid);
      case 'library': return showLibrary(msg.chat.id, uid);
      case 'invite': return showInvite(msg.chat.id, uid);
      case 'help': return showHelp(msg.chat.id, uid);
      case 'paysupport': return openSupport(msg.chat.id, msg.from);
      default: return send(msg.chat.id, 'I did not recognize that command. Here is the menu:', { reply_markup: mainMenu() });
    }
  }

  async function onCallback(cq) {
    const chatId = cq.message?.chat?.id ?? cq.from.id;
    const { user } = db.upsertUser(cq.from);
    const uid = user.telegram_user_id;
    const [action, a, b] = String(cq.data || '').split(':');
    let toast;
    try {
      switch (action) {
        case 'sample': await sendSample(chatId, uid, a); break;
        case 'shelf': await showShelf(chatId, uid); break;
        case 'library': await showLibrary(chatId, uid); break;
        case 'buy': await sendBookInvoice(chatId, uid, a); break;
        case 'dl': {
          const book = db.getBook(a);
          if (!book || !FORMATS.includes(b) || !db.ownsBook(uid, a)) { toast = 'This book is not in your library.'; break; }
          await deliverBook(chatId, book, [b]);
          break;
        }
        case 'alerts':
          db.setAlertOptIn(uid, a === 'on');
          toast = a === 'on' ? 'Drop alerts on 🔔' : 'Drop alerts off 🔕';
          break;
        case 'ticket':
          if (a === 'open') await openSupport(chatId, cq.from);
          if (a === 'close') {
            const t = db.getOpenTicket(uid);
            if (t && db.closeTicket(t.id)) {
              await send(chatId, `✅ Ticket #${t.id} closed. Thanks for your patience.`);
              await notifySupport(`Ticket #${t.id} was closed by the user.`, inThread(t));
              await closeTicketTopic(t);
            } else toast = 'No open ticket.';
          }
          break;
        default: toast = 'That button has expired.';
      }
    } finally {
      await call('answerCallbackQuery', { callback_query_id: cq.id, ...(toast ? { text: toast } : {}) }).catch(() => {});
    }
  }

  async function handleUpdate(update) {
    try {
      if (update.pre_checkout_query) return await onPreCheckout(update.pre_checkout_query);
      if (update.callback_query) return await onCallback(update.callback_query);
      if (update.my_chat_member && update.my_chat_member.chat.type === 'private') {
        const st = update.my_chat_member.new_chat_member?.status;
        if (st === 'kicked') db.setAlertOptIn(update.my_chat_member.from.id, false);
        return null;
      }
      const msg = update.message;
      if (!msg || !msg.from) return null;
      if (msg.successful_payment) return await onSuccessfulPayment(msg);
      if (isSupportChat(msg.chat.id)) return await onSupportChatMessage(msg);
      if (msg.chat.type !== 'private') return null;
      if (msg.text?.startsWith('/')) return await onCommand(msg);
      db.upsertUser(msg.from);
      const ticket = db.getOpenTicket(msg.from.id);
      if (ticket) return await relayToSupport(msg, ticket);
      return await send(msg.chat.id, 'Pick an option below, or send /help.', { reply_markup: mainMenu() });
    } catch (e) {
      log.error?.(`update ${update.update_id} failed: ${e.stack || e.message}`);
      // Payment updates must be retried by Telegram (webhook) or the poller; recording is idempotent.
      if (update.message?.successful_payment) throw e;
      return null;
    }
  }

  async function registerCommands() {
    await call('setMyCommands', { commands: COMMANDS });
  }

  return { handleUpdate, registerCommands, deliverBook, sendFile, notifySupport };
}
