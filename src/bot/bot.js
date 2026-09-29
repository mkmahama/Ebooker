import { basename } from 'node:path';
import { msg, esc } from './messages.js';
import { starsPrice } from '../pricing.js';

// The seven public commands. Everything else is inline buttons.
export const COMMANDS = [
  { command: 'start', description: 'Welcome and main menu' },
  { command: 'shelf', description: 'Browse books on sale' },
  { command: 'sample', description: 'Get a free chapter' },
  { command: 'library', description: 'Re-download your books' },
  { command: 'invite', description: 'Your referral link and progress' },
  { command: 'help', description: 'FAQ and refund policy' },
  { command: 'paysupport', description: 'Help with a payment' },
];

const cb = (text, data) => ({ text, callback_data: data });
const url = (text, href) => ({ text, url: href });

export class Bot {
  /**
   * @param {object} deps
   * @param {import('../telegram/api.js').TelegramApi} deps.api
   * @param {import('../store.js').Store} deps.store
   * @param {import('../files/storage.js').Files} deps.files
   */
  constructor({ api, store, files, config, log = console, hooks = {} }) {
    this.api = api;
    this.store = store;
    this.files = files;
    this.config = config;
    this.log = log;
    // v2 hook point (e.g. proof-of-purchase collectible): called after every fulfilled purchase.
    this.hooks = { onPurchase: hooks.onPurchase || (async () => {}) };
  }

  send(chatId, text, extra = {}) {
    return this.api.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }

  deepLink(payload) {
    return `https://t.me/${this.config.bot.username}?start=${payload}`;
  }

  mainMenu() {
    return {
      inline_keyboard: [
        [cb('📖 Get a free chapter', 'sample')],
        [cb('📚 Browse the shelf', 'shelf')],
        [cb('🗂 My library', 'library')],
      ],
    };
  }

  // ---------------------------------------------------------------- dispatch

  async handleUpdate(update) {
    try {
      if (update.pre_checkout_query) return await this.onPreCheckout(update.pre_checkout_query);
      if (update.callback_query) return await this.onCallback(update.callback_query);
      if (update.message) return await this.onMessage(update.message);
    } catch (err) {
      this.log.error?.(`[bot] update ${update.update_id} failed: ${err.stack || err.message}`);
    }
  }

  async onMessage(m) {
    const supportChat = this.config.support.chatId;
    if (supportChat && String(m.chat.id) === String(supportChat)) return this.onSupportChatMessage(m);
    if (m.chat.type !== 'private' || !m.from) return;

    const { user, created } = this.store.upsertUser(m.from);
    if (m.successful_payment) return this.onSuccessfulPayment(m, user);
    if (m.refunded_payment) return this.onRefundedPayment(m);

    const text = m.text || '';
    const cmd = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s+(.+))?$/i);
    if (cmd) {
      const [, name, arg] = cmd;
      switch (name.toLowerCase()) {
        case 'start': return this.cmdStart(m, user, created, arg?.trim());
        case 'shelf': return this.cmdShelf(user);
        case 'sample': return this.cmdSample(user);
        case 'library': return this.cmdLibrary(user);
        case 'invite': return this.cmdInvite(user);
        case 'help': return this.cmdHelp(user);
        case 'paysupport': return this.cmdPaySupport(user);
        default: break;
      }
    }
    // Messages sent while a support ticket is open go to the support thread.
    const ticket = this.store.openTicket(user.telegram_user_id);
    if (ticket && !cmd) return this.forwardToSupport(m, user, ticket);
    return this.send(user.telegram_user_id, msg.unknown, { reply_markup: this.mainMenu() });
  }

  async onCallback(q) {
    const { user } = this.store.upsertUser(q.from);
    const uid = user.telegram_user_id;
    const [action, a1, a2] = String(q.data || '').split(':');
    let answer = {};
    switch (action) {
      case 'sample': await (a1 ? this.sendBookSample(user, Number(a1)) : this.cmdSample(user)); break;
      case 'shelf': await this.cmdShelf(user); break;
      case 'library': await this.cmdLibrary(user); break;
      case 'invite': await this.cmdInvite(user); break;
      case 'buy': await this.sendInvoice(user, Number(a1)); break;
      case 'dl': answer = await this.redownload(user, Number(a1), a2); break;
      case 'alerts':
        this.store.setAlertOptIn(uid, a1 === 'on');
        answer = { text: a1 === 'on' ? 'Drop alerts on' : 'Drop alerts off' };
        await this.send(uid, a1 === 'on' ? msg.alertsOn : msg.alertsOff);
        break;
      case 'support': await (a1 === 'close' ? this.closeTicketByUser(user) : this.cmdPaySupport(user)); break;
      case 'tclose':
        // Staff-only: honoured only when pressed inside the support chat.
        if (String(q.message?.chat?.id) === String(this.config.support.chatId)) {
          await this.closeTicketFromSupport(Number(a1));
          answer = { text: 'Ticket closed' };
        }
        break;
      default: break;
    }
    await this.api.call('answerCallbackQuery', { callback_query_id: q.id, ...answer }).catch(() => {});
  }

  // ---------------------------------------------------------------- commands

  async cmdStart(m, user, created, payload) {
    const uid = user.telegram_user_id;
    if (payload) this.store.logEvent(uid, 'start', { payload, new_user: created });

    let referred = false;
    if (payload?.startsWith('ref_')) {
      const referrer = this.store.getUserByReferralCode(payload.slice(4));
      // Only brand-new users can be attributed, so existing customers can't be "re-referred".
      if (referrer && created) referred = this.store.setReferrer(uid, referrer.telegram_user_id);
    }

    await this.send(uid, msg.welcome(m.from.first_name) + (referred ? `\n\n${msg.welcomeReferred}` : ''), { reply_markup: this.mainMenu() });

    if (!payload) return;
    if (payload === 'sample' || payload.startsWith('sample_')) return this.cmdSample(user);
    if (payload === 'shelf') return this.cmdShelf(user);
    if (payload === 'library') return this.cmdLibrary(user);
    if (payload.startsWith('buy_')) {
      const book = this.store.getBookBySlug(payload.slice(4));
      return book ? this.sendInvoice(user, book.id) : this.send(uid, msg.bookUnavailable);
    }
    if (payload.startsWith('book_')) {
      const book = this.store.getBookBySlug(payload.slice(5));
      if (book?.active) return this.sendShelfItem(user, book, this.store.ownedBookIds(uid));
    }
    if (payload.startsWith('claim_')) return this.claimWebOrder(user, payload.slice(6));
  }

  async cmdShelf(user) {
    const uid = user.telegram_user_id;
    const books = this.store.activeBooks();
    if (!books.length) return this.send(uid, msg.shelfEmpty);
    const owned = this.store.ownedBookIds(uid);
    for (const book of books) await this.sendShelfItem(user, book, owned);
  }

  async sendShelfItem(user, book, owned) {
    const uid = user.telegram_user_id;
    const isOwned = this.store.unlockedBookIds(book).every((id) => owned.has(id));
    const caption = msg.shelfItem(book, isOwned);
    const row = isOwned
      ? [cb('🗂 Open library', 'library')]
      : [cb(`⭐ Buy · ${starsPrice(book)} Stars`, `buy:${book.id}`)];
    if (book.kind === 'book') row.push(cb('📖 Free chapter', `sample:${book.id}`));
    const reply_markup = { inline_keyboard: [row] };

    const cover = this.files.coverPath(book);
    if (cover) {
      try {
        return await this.sendFile('sendPhoto', 'photo', uid, cover, { caption, parse_mode: 'HTML', reply_markup });
      } catch (err) {
        this.log.warn?.(`[bot] cover failed for ${book.slug}: ${err.message}`);
      }
    }
    return this.send(uid, caption, { reply_markup });
  }

  /** /sample: the lead-magnet chapter (AI daily brief guide + n8n JSON) and drop-alert opt-in. */
  async cmdSample(user) {
    const uid = user.telegram_user_id;
    const paths = this.files.samplePaths();
    if (!paths.length) return this.send(uid, msg.sampleMissing);
    await this.send(uid, msg.sampleIntro);
    for (const p of paths) await this.sendFile('sendDocument', 'document', uid, p);
    return this.afterSample(user, this.store.getBookBySlug('ai-control-center'));
  }

  async sendBookSample(user, bookId) {
    const uid = user.telegram_user_id;
    const book = this.store.getBook(bookId);
    if (!book?.active) return this.send(uid, msg.bookUnavailable);
    const paths = this.files.samplePaths(book);
    if (!paths.length) return this.send(uid, msg.sampleMissing);
    const own = paths[0].includes(`/samples/${book.slug}/`);
    await this.send(uid, own ? msg.sampleBookIntro(book) : msg.sampleIntro);
    for (const p of paths) await this.sendFile('sendDocument', 'document', uid, p);
    return this.afterSample(user, own ? book : this.store.getBookBySlug('ai-control-center'));
  }

  async afterSample(user, upsellBook) {
    const uid = user.telegram_user_id;
    const wasOptedIn = !!this.store.getUser(uid).alert_opt_in;
    this.store.setAlertOptIn(uid, true);
    this.store.logEvent(uid, 'sample', { book: upsellBook?.slug });
    const rows = [];
    if (upsellBook?.active && !this.store.ownsAll(uid, upsellBook)) {
      rows.push([cb(`⭐ Buy the full book · ${starsPrice(upsellBook)} Stars`, `buy:${upsellBook.id}`)]);
    }
    rows.push([cb('📚 Browse the shelf', 'shelf'), cb('🔕 No drop alerts', 'alerts:off')]);
    return this.send(uid, msg.sampleOutro(wasOptedIn), { reply_markup: { inline_keyboard: rows } });
  }

  async cmdLibrary(user) {
    const uid = user.telegram_user_id;
    const books = this.store.libraryBooks(uid);
    if (!books.length) {
      return this.send(uid, msg.libraryEmpty, { reply_markup: { inline_keyboard: [[cb('📚 Browse the shelf', 'shelf'), cb('📖 Free chapter', 'sample')]] } });
    }
    const inline_keyboard = [];
    for (const b of books) {
      inline_keyboard.push([cb(`📘 EPUB · ${b.short_title}`, `dl:${b.id}:epub`), cb(`📄 PDF · ${b.short_title}`, `dl:${b.id}:pdf`)]);
    }
    const text = msg.libraryHeader(books.length) + '\n\n' + books.map((b) => `• ${esc(b.title)}`).join('\n');
    return this.send(uid, text, { reply_markup: { inline_keyboard } });
  }

  async cmdInvite(user) {
    const uid = user.telegram_user_id;
    const link = this.deepLink(`ref_${user.referral_code}`);
    const reward = this.store.getBookBySlug(this.config.referral.rewardSlug);
    const qualified = this.store.qualifiedReferralCount(uid);
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(msg.inviteShareText)}`;
    return this.send(uid, msg.invite(link, qualified, this.config.referral.target, reward?.title || 'a free book', !!user.referral_reward_granted_at), {
      reply_markup: { inline_keyboard: [[url('📤 Share your link', share)]] },
    });
  }

  async cmdHelp(user) {
    const contact = this.config.support.contactUrl
      ? url('✉️ Contact us', this.config.support.contactUrl)
      : cb('✉️ Contact us', 'support');
    return this.send(user.telegram_user_id, msg.help, {
      reply_markup: { inline_keyboard: [[contact], [cb('🛟 Payment problem', 'support')]] },
    });
  }

  // ---------------------------------------------------------------- Stars payments

  async sendInvoice(user, bookId) {
    const uid = user.telegram_user_id;
    const book = this.store.getBook(bookId);
    if (!book?.active) return this.send(uid, msg.bookUnavailable);
    if (this.store.ownsAll(uid, book)) return this.send(uid, msg.alreadyOwned(book), { reply_markup: { inline_keyboard: [[cb('🗂 My library', 'library')]] } });
    const amount = starsPrice(book);
    const invoice = this.store.createInvoice(uid, book.id, amount);
    this.store.logEvent(uid, 'invoice', { book: book.slug, stars: amount });
    return this.api.call('sendInvoice', {
      chat_id: uid,
      title: book.short_title.slice(0, 32),
      description: book.description.slice(0, 255),
      payload: invoice.id,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: book.short_title.slice(0, 32), amount }],
    });
  }

  /** Must be answered within 10 seconds; this does only local DB reads. */
  async onPreCheckout(q) {
    const invoice = this.store.getInvoice(q.invoice_payload);
    const book = invoice && this.store.getBook(invoice.book_id);
    let error = null;
    const ttl = this.config.pricing.invoiceTtlHours * 3600_000;
    if (!invoice || !book || q.currency !== 'XTR' || invoice.telegram_user_id !== q.from.id || q.total_amount !== invoice.stars_amount) {
      error = msg.preCheckoutFailed;
    } else if (!book.active || invoice.paid_at || Date.now() - invoice.created_at > ttl) {
      error = msg.preCheckoutFailed;
    } else if (this.store.ownsAll(q.from.id, book)) {
      error = msg.preCheckoutOwned;
    }
    await this.api.call('answerPreCheckoutQuery', error
      ? { pre_checkout_query_id: q.id, ok: false, error_message: error }
      : { pre_checkout_query_id: q.id, ok: true });
    return !error;
  }

  /** Fulfillment happens only here, after Telegram confirms the payment. */
  async onSuccessfulPayment(m, user) {
    const sp = m.successful_payment;
    const uid = user.telegram_user_id;
    const invoice = this.store.getInvoice(sp.invoice_payload);
    if (sp.currency !== 'XTR' || !invoice || invoice.telegram_user_id !== uid) {
      this.log.error?.(`[pay] unexpected successful_payment ${sp.telegram_payment_charge_id} for payload ${sp.invoice_payload}`);
      await this.notifySupport(`⚠️ Unmatched Stars payment from <code>${uid}</code>: charge <code>${esc(sp.telegram_payment_charge_id)}</code>, payload ${esc(sp.invoice_payload)}`);
      return null;
    }
    const purchase = this.store.recordPurchase({
      userId: uid,
      bookId: invoice.book_id,
      method: 'stars',
      starsPaid: sp.total_amount,
      chargeId: sp.telegram_payment_charge_id,
      providerChargeId: sp.provider_payment_charge_id || null,
    });
    if (!purchase) return null; // duplicate update: already fulfilled
    this.store.markInvoicePaid(invoice.id);
    const book = this.store.getBook(invoice.book_id);
    this.store.logEvent(uid, 'purchase', { book: book.slug, method: 'stars', stars: sp.total_amount });

    await this.send(uid, msg.receipt(book, sp.total_amount, sp.telegram_payment_charge_id));
    await this.deliverProduct(user, book);
    await this.creditReferrer(user);
    await this.hooks.onPurchase({ user, book, purchase });
    return purchase;
  }

  /** Telegram reports refunds made outside our admin tool (e.g. by Telegram support). */
  async onRefundedPayment(m) {
    const rp = m.refunded_payment;
    if (this.store.markRefunded(rp.telegram_payment_charge_id)) {
      this.log.info?.(`[pay] refund recorded for ${rp.telegram_payment_charge_id}`);
    }
  }

  /** Refunds a Stars purchase through the Bot API and confirms to the user. */
  async refund(chargeId) {
    const p = this.store.getPurchaseByCharge(chargeId);
    if (!p) throw new Error(`no purchase with charge id ${chargeId}`);
    if (p.refunded_at) throw new Error('already refunded');
    if (p.method !== 'stars') throw new Error(`${p.method} purchases are not refundable through the Bot API`);
    await this.api.call('refundStarPayment', { user_id: p.telegram_user_id, telegram_payment_charge_id: chargeId });
    this.store.markRefunded(chargeId);
    this.store.logEvent(p.telegram_user_id, 'refund', { charge_id: chargeId });
    await this.send(p.telegram_user_id, msg.refundConfirmed(this.store.getBook(p.book_id), p.stars_paid)).catch(() => {});
    return p;
  }

  // ---------------------------------------------------------------- delivery

  /** Sends a local file, reusing Telegram's file_id for files that are the same for everyone. */
  async sendFile(method, field, chatId, path, extra = {}) {
    const mtime = this.files.mtime(path);
    const cached = this.store.getCachedFileId(path, mtime);
    if (cached) {
      try {
        return await this.api.call(method, { chat_id: chatId, [field]: cached, ...extra });
      } catch (err) {
        this.log.warn?.(`[bot] cached file_id failed for ${path}, re-uploading: ${err.message}`);
      }
    }
    const res = await this.api.call(method, { chat_id: chatId, [field]: { path, filename: basename(path) }, ...extra });
    const fileId = field === 'photo' ? res.photo?.at(-1)?.file_id : res.document?.file_id;
    if (fileId) this.store.setCachedFileId(path, mtime, fileId);
    return res;
  }

  /** Sends one book file. PDFs are stamped with the buyer's id so they are never cached. */
  async sendBookFile(uid, book, format) {
    const path = this.files.bookPath(book, format);
    if (!path) return false;
    if (format === 'pdf') {
      const license = `Licensed to Telegram user ${uid} · Drop Shelf · Please do not share`;
      const buffer = await this.files.stampedPdf(path, license, this.log);
      await this.api.call('sendDocument', { chat_id: uid, document: { buffer, filename: `${book.slug}.pdf`, contentType: 'application/pdf' } });
    } else {
      await this.sendFile('sendDocument', 'document', uid, path);
    }
    return true;
  }

  async deliverProduct(user, product) {
    const uid = user.telegram_user_id;
    for (const id of this.store.unlockedBookIds(product)) {
      const book = this.store.getBook(id);
      await this.send(uid, msg.delivery(book));
      let sent = 0;
      for (const format of ['epub', 'pdf']) {
        try {
          if (await this.sendBookFile(uid, book, format)) sent++;
        } catch (err) {
          this.log.error?.(`[deliver] ${book.slug}.${format} to ${uid}: ${err.message}`);
        }
      }
      if (sent < 2) {
        await this.send(uid, msg.deliveryMissing(book));
        await this.notifySupport(`⚠️ Delivery incomplete: <b>${esc(book.slug)}</b> to <code>${uid}</code> (${sent}/2 files). Check storage/books/${esc(book.slug)}/`);
      }
      if (book.reader_group_url) {
        await this.send(uid, msg.readerGroup(book), { reply_markup: { inline_keyboard: [[url('💬 Join the reader group', book.reader_group_url)]] } });
      }
    }
    await this.send(uid, '🗂 All your books live in /library.', { reply_markup: { inline_keyboard: [[cb('🗂 My library', 'library'), cb('🤝 Get a free book', 'invite')]] } }).catch(() => {});
  }

  async redownload(user, bookId, format) {
    const uid = user.telegram_user_id;
    if (!this.store.ownedBookIds(uid).has(bookId)) return { text: msg.notOwned, show_alert: true };
    const book = this.store.getBook(bookId);
    this.store.logEvent(uid, 'download', { book: book.slug, format });
    try {
      if (!(await this.sendBookFile(uid, book, format))) return { text: msg.formatMissing, show_alert: true };
    } catch (err) {
      this.log.error?.(`[library] ${book.slug}.${format} to ${uid}: ${err.message}`);
      return { text: msg.formatMissing, show_alert: true };
    }
    return { text: `Sending ${format.toUpperCase()}…` };
  }

  // ---------------------------------------------------------------- referrals

  /** After a buyer's first paid purchase, count it for their referrer and grant the reward at the target. */
  async creditReferrer(buyer) {
    if (!buyer.referrer_id || this.store.paidPurchaseCount(buyer.telegram_user_id) !== 1) return;
    const referrer = this.store.getUser(buyer.referrer_id);
    if (!referrer) return;
    const target = this.config.referral.target;
    const qualified = this.store.qualifiedReferralCount(referrer.telegram_user_id);
    if (qualified < target) {
      await this.send(referrer.telegram_user_id, msg.referralProgress(qualified, target)).catch(() => {});
      return;
    }
    const reward = this.store.getBookBySlug(this.config.referral.rewardSlug);
    if (!reward || !this.store.claimReferralReward(referrer.telegram_user_id)) return;
    this.store.recordPurchase({ userId: referrer.telegram_user_id, bookId: reward.id, method: 'referral', chargeId: `referral:${referrer.telegram_user_id}` });
    this.store.logEvent(referrer.telegram_user_id, 'referral_reward', { book: reward.slug });
    await this.send(referrer.telegram_user_id, msg.referralReward(reward)).catch(() => {});
    await this.deliverProduct(referrer, reward).catch((err) => this.log.error?.(`[referral] delivery failed: ${err.message}`));
  }

  // ---------------------------------------------------------------- TON web order claim

  async claimWebOrder(user, token) {
    const uid = user.telegram_user_id;
    const order = token && this.store.getTonOrderByClaimToken(token);
    if (!order || order.status !== 'paid') return this.send(uid, msg.claimInvalid);
    if (!this.store.claimTonOrder(order.id, uid)) return this.send(uid, msg.claimUsed);
    this.store.recordPurchase({ userId: uid, bookId: order.book_id, method: 'ton', tonPaidNano: order.paid_nano, chargeId: order.tx_hash });
    const book = this.store.getBook(order.book_id);
    this.store.logEvent(uid, 'claim', { order: order.id, book: book.slug });
    await this.send(uid, msg.claimOk(book), { reply_markup: { inline_keyboard: [[cb('🗂 My library', 'library')]] } });
    await this.creditReferrer(this.store.getUser(uid));
  }

  // ---------------------------------------------------------------- /paysupport threads

  async notifySupport(text, extra = {}) {
    if (!this.config.support.chatId) return null;
    return this.send(this.config.support.chatId, text, extra).catch((err) => this.log.error?.(`[support] ${err.message}`));
  }

  async cmdPaySupport(user) {
    const uid = user.telegram_user_id;
    if (!this.config.support.chatId) return this.send(uid, msg.supportUnavailable);
    const existing = this.store.openTicket(uid);
    if (existing) return this.send(uid, msg.supportAlreadyOpen(existing.id), { reply_markup: this.ticketUserKeyboard() });

    const ticket = this.store.createTicket(uid);
    this.store.logEvent(uid, 'support_open', { ticket: ticket.id });
    const chatId = this.config.support.chatId;
    let threadId;
    if (this.config.support.useTopics) {
      try {
        const topic = await this.api.call('createForumTopic', { chat_id: chatId, name: `#${ticket.id} · ${user.username ? '@' + user.username : user.first_name || uid}`.slice(0, 128) });
        threadId = topic.message_thread_id;
        this.store.setTicketTopic(ticket.id, threadId);
      } catch (err) {
        this.log.warn?.(`[support] createForumTopic failed, falling back to replies: ${err.message}`);
      }
    }
    const purchases = this.store.getUserProfile(uid).purchases;
    const header = await this.send(chatId, msg.supportHeader(ticket, this.store.getUser(uid), purchases), {
      ...(threadId ? { message_thread_id: threadId } : {}),
      reply_markup: { inline_keyboard: [[cb('✅ Close ticket', `tclose:${ticket.id}`)]] },
    });
    this.store.linkSupportMessage(header.message_id, ticket.id);
    return this.send(uid, msg.supportOpened(ticket.id), { reply_markup: this.ticketUserKeyboard() });
  }

  ticketUserKeyboard() {
    return { inline_keyboard: [[cb('✅ Resolved, close ticket', 'support:close')]] };
  }

  async forwardToSupport(m, user, ticket) {
    const chatId = this.config.support.chatId;
    const copied = await this.api.call('copyMessage', {
      chat_id: chatId,
      from_chat_id: m.chat.id,
      message_id: m.message_id,
      ...(ticket.topic_id ? { message_thread_id: ticket.topic_id } : {}),
      caption: m.caption ? `#${ticket.id} · ${m.caption}`.slice(0, 1024) : undefined,
    });
    this.store.linkSupportMessage(copied.message_id, ticket.id);
    if (!ticket.topic_id && m.text) {
      // Reply-based threads: label the copy so the team knows which ticket it belongs to.
      const label = await this.send(chatId, `↑ #${ticket.id} from <code>${user.telegram_user_id}</code>`, { reply_to_message_id: copied.message_id });
      this.store.linkSupportMessage(label.message_id, ticket.id);
    }
    return this.send(user.telegram_user_id, msg.supportForwarded);
  }

  /** Staff messages in the support chat: inside a ticket topic, or replies to a ticket message, go to the user. */
  async onSupportChatMessage(m) {
    if (m.from?.is_bot) return;
    let ticket = null;
    if (m.is_topic_message && m.message_thread_id) ticket = this.store.getTicketByTopic(m.message_thread_id);
    if (!ticket && m.reply_to_message) ticket = this.store.ticketForSupportMessage(m.reply_to_message.message_id);
    if (!ticket) return;
    if (ticket.status !== 'open') {
      return this.send(m.chat.id, `Ticket #${ticket.id} is closed; message not delivered.`, m.message_thread_id ? { message_thread_id: m.message_thread_id } : {});
    }
    this.store.linkSupportMessage(m.message_id, ticket.id);
    if (m.text) return this.send(ticket.telegram_user_id, msg.supportReply(ticket.id, m.text), { reply_markup: this.ticketUserKeyboard() });
    return this.api.call('copyMessage', { chat_id: ticket.telegram_user_id, from_chat_id: m.chat.id, message_id: m.message_id });
  }

  async closeTicketByUser(user) {
    const ticket = this.store.openTicket(user.telegram_user_id);
    if (!ticket) return;
    return this.closeTicket(ticket);
  }

  async closeTicketFromSupport(ticketId) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket) return this.closeTicket(ticket);
  }

  async closeTicket(ticket) {
    if (!this.store.closeTicket(ticket.id)) return;
    await this.send(ticket.telegram_user_id, msg.supportClosedUser(ticket.id)).catch(() => {});
    const chatId = this.config.support.chatId;
    await this.send(chatId, `✅ Ticket #${ticket.id} closed.`, ticket.topic_id ? { message_thread_id: ticket.topic_id } : {}).catch(() => {});
    if (ticket.topic_id) await this.api.call('closeForumTopic', { chat_id: chatId, message_thread_id: ticket.topic_id }).catch(() => {});
  }

  // ---------------------------------------------------------------- drops (admin)

  /** Sends the drop alert to opted-in users and the launch post to the channel. */
  async announceDrop(book, { webUrl } = {}) {
    let sent = 0, failed = 0;
    const keyboard = { inline_keyboard: [[cb(`⭐ Buy · ${starsPrice(book)} Stars`, `buy:${book.id}`)], [cb('📖 Free chapter', `sample:${book.id}`), cb('🔕 Stop alerts', 'alerts:off')]] };
    for (const uid of this.store.alertSubscribers()) {
      try {
        await this.send(uid, msg.dropAlert(book), { reply_markup: keyboard });
        sent++;
      } catch (err) {
        failed++;
        if (err.code === 403) this.store.setAlertOptIn(uid, false); // user blocked the bot
        if (err.retryAfter) await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
      }
      await new Promise((r) => setTimeout(r, 40)); // stay under ~25 msg/s
    }
    if (this.config.channel.id) {
      const rows = [[url(`⭐ Buy in @${this.config.bot.username}`, this.deepLink(`buy_${book.slug}`))], [url('📖 Free chapter', this.deepLink('sample_channel'))]];
      if (webUrl) rows.push([url('💎 Pay with TON on the web', webUrl)]);
      await this.send(this.config.channel.id, msg.channelPost(book).replace('@BOT', '@' + this.config.bot.username), { reply_markup: { inline_keyboard: rows } });
    }
    return { sent, failed };
  }
}
