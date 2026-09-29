import { starsPrice, isLaunchPrice } from '../pricing.js';

// All user-facing copy lives here (HTML parse mode).
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const REFUND_POLICY =
  'Refunds are available within 24 hours of purchase if the book is not what you expected or the files do not work. ' +
  'Open /paysupport, tell us which book, and we refund the Stars to your Telegram balance through Telegram. ' +
  'Refunded books are removed from your library. One no-questions refund per customer.';

export const msg = {
  welcome: (name) =>
    `👋 Hi ${esc(name || 'there')}, welcome to <b>Drop Shelf</b>.\n\n` +
    'Short, tested guides for running AI automations from Telegram. New books drop one at a time, with a launch price for the first 48 hours.\n\n' +
    'Start with a free chapter, or browse the shelf.',

  welcomeReferred: 'A friend sent you here. Grab the free chapter first; it takes 20 minutes and proves the workflows work.',

  shelfEmpty: 'The shelf is empty right now. Turn on drop alerts with /sample and you will hear about the next book first.',

  shelfItem: (book, owned, at = Date.now()) => {
    const price = starsPrice(book, at);
    const lines = [];
    if (book.is_current_drop) lines.push('🔥 <b>Current drop</b>');
    lines.push(`<b>${esc(book.title)}</b>`, esc(book.pitch));
    if (book.audience) lines.push(`<i>For: ${esc(book.audience)}</i>`);
    if (owned) lines.push('✅ In your library');
    else if (isLaunchPrice(book, at)) {
      const until = book.launch_ends_at ? ` until ${new Date(book.launch_ends_at).toUTCString().slice(5, 22)} UTC` : '';
      lines.push(`⭐ <b>${price} Stars</b> launch price${until} (then ${book.full_price_stars})`);
    } else lines.push(`⭐ <b>${price} Stars</b>`);
    return lines.join('\n');
  },

  sampleIntro:
    '📖 <b>Free chapter: AI daily brief to your Telegram</b>\n\n' +
    'One complete workflow from <i>Telegram as Your AI Control Center</i>: every morning n8n pulls your calendar, inbox and feeds, an AI model summarizes them, and the brief lands in Telegram. ' +
    'The guide and the importable n8n JSON are below. Setup takes about 20 minutes.',

  sampleBookIntro: (book) => `📖 <b>Free chapter</b> from <i>${esc(book.title)}</i>:`,

  sampleOutro: (alreadyOptedIn) =>
    (alreadyOptedIn ? '🔔 You are on the drop alert list.' : '🔔 You are now on the drop alert list: you will hear about new books and launch prices first.') +
    '\n\nLiked it? The full book has 8–10 more workflows like this one.',

  sampleMissing: 'The free chapter is being updated. Please try again in a little while.',

  alertsOff: '🔕 Drop alerts turned off. Use /sample any time to turn them back on.',
  alertsOn: '🔔 Drop alerts turned on.',

  alreadyOwned: (book) => `✅ <b>${esc(book.title)}</b> is already in your library. Open /library to download it again.`,
  bookUnavailable: 'That book is not on sale right now. See /shelf for what is available.',

  preCheckoutFailed: 'This invoice has expired or the price changed. Tap Buy again for a fresh invoice.',
  preCheckoutOwned: 'You already own this book. Open /library to download it.',

  // Purchase receipt
  receipt: (book, stars, chargeId) =>
    `🧾 <b>Receipt</b>\n\n${esc(book.title)}\nPaid: ⭐ ${stars} Stars\nDate: ${new Date().toUTCString()}\n` +
    `Transaction: <code>${esc(chargeId)}</code>\n\nKeep this for support. Payment problems: /paysupport`,

  // Delivery message
  delivery: (book) =>
    `📦 Here is <b>${esc(book.title)}</b> (EPUB + PDF). Your PDF is licensed to you personally.\n` +
    'You can download it again any time from /library, and free updates arrive here when the tools change.',

  readerGroup: (book) => `💬 Buyers of <i>${esc(book.title)}</i> get a private group for setup help:`,

  deliveryMissing: (book) =>
    `⚠️ Your purchase of <b>${esc(book.title)}</b> is saved, but the files are not available right now. ` +
    'We have been notified. Use /library to download them shortly, or /paysupport if it persists.',

  libraryEmpty: 'Your library is empty. Browse the /shelf, or start with a free chapter via /sample.',
  libraryHeader: (n) => `📚 <b>Your library</b> (${n} book${n === 1 ? '' : 's'})\nTap a format to download again.`,
  notOwned: 'That book is not in your library.',
  formatMissing: 'That format is not available yet. Try the other format, or /paysupport.',

  invite: (link, qualified, target, rewardTitle, rewarded) =>
    `🤝 <b>Invite friends, get a free book</b>\n\nYour link:\n${esc(link)}\n\n` +
    (rewarded
      ? `🎁 You unlocked <i>${esc(rewardTitle)}</i>. Thanks for spreading the word!`
      : `<b>${Math.min(qualified, target)} of ${target}</b> referrals to your free book (<i>${esc(rewardTitle)}</i>).\n` +
        'A referral counts when someone who opened your link buys any book.'),
  inviteShareText: 'Free chapter: an AI daily brief that lands in your Telegram every morning.',

  // Referral reward notice
  referralProgress: (qualified, target) => `🎉 A friend you invited just bought a book. ${qualified} of ${target} referrals to your free book.`,
  referralReward: (book) => `🎁 <b>You unlocked a free book!</b>\n\n${esc(book.title)} is now in your library. Thanks for sharing Drop Shelf.`,

  help:
    '❓ <b>Help</b>\n\n' +
    '<b>How do I pay?</b>\nWith Telegram Stars, right here in the chat. Tap Buy on any book in /shelf.\n\n' +
    '<b>Where are my books?</b>\nIn /library. Every purchase includes EPUB and PDF, and you can re-download any time.\n\n' +
    '<b>What devices work?</b>\nEPUB for phone and e-reader apps (Apple Books, Google Play Books, KOReader); PDF for everything else.\n\n' +
    '<b>Do I get updates?</b>\nYes. When n8n, Zapier or Make change, updated files are sent here for free.\n\n' +
    '<b>Free book?</b>\nInvite friends with /invite.\n\n' +
    `<b>Refund policy</b>\n${REFUND_POLICY}\n\n` +
    'Payment problem? Use /paysupport.',

  // Support thread
  supportOpened: (ticketId) =>
    `🛟 <b>Payment support, ticket #${ticketId}</b>\n\n` +
    'Describe the problem in your next messages: which book, roughly when you paid, and what went wrong. ' +
    'Screenshots help. Everything you send here goes to our team until the ticket is closed, and replies arrive in this chat.',
  supportAlreadyOpen: (ticketId) => `🛟 Ticket #${ticketId} is open. Send your messages here and our team will reply in this chat.`,
  supportUnavailable: 'Support is not configured yet. Please try again later.',
  supportForwarded: '📨 Sent to support. We will reply here.',
  supportReply: (ticketId, text) => `💬 <b>Support (ticket #${ticketId})</b>\n\n${esc(text)}`,
  supportClosedUser: (ticketId) => `✅ Ticket #${ticketId} is closed. Use /paysupport if you need anything else.`,
  supportHeader: (ticket, user, purchases) =>
    `🛟 <b>Ticket #${ticket.id}</b> from ${esc(user.first_name || '')} ${user.username ? '@' + esc(user.username) : ''} (<code>${user.telegram_user_id}</code>)\n` +
    (purchases.length
      ? 'Purchases:\n' + purchases.map((p) => `• ${esc(p.slug)} · ${p.method} · ${p.stars_paid ? p.stars_paid + '⭐' : ''} · <code>${esc(p.charge_id)}</code>${p.refunded_at ? ' · refunded' : ''}`).join('\n')
      : 'No purchases.') +
    '\n\nReply in this thread to answer the user.',

  // Refund confirmation
  refundConfirmed: (book, stars) =>
    `↩️ <b>Refund confirmed</b>\n\n${stars} Stars for <i>${esc(book.title)}</i> are on their way back to your Telegram balance. ` +
    'The book has been removed from your library.',

  claimOk: (book) => `✅ <b>${esc(book.title)}</b> from your web order is now in your /library.`,
  claimUsed: 'This web order has already been added to a Telegram library.',
  claimInvalid: 'That claim link is not valid.',

  // Drop alert (subscribers) and channel launch post
  dropAlert: (book, at = Date.now()) =>
    `🚀 <b>New drop: ${esc(book.title)}</b>\n\n${esc(book.pitch)}\n\n` +
    `⭐ Launch price <b>${starsPrice(book, at)} Stars</b> for 48 hours (then ${book.full_price_stars}).`,
  channelPost: (book, at = Date.now()) =>
    `🚀 <b>${esc(book.title)}</b> is live\n\n${esc(book.pitch)}\n\n` +
    `Launch price for 48 hours: ⭐ ${starsPrice(book, at)} Stars in @BOT.\nFree chapter first? Tap below.`,

  unknown: 'I did not catch that. Try /shelf, /library or /help.',
};
