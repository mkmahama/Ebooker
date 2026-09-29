import { starsPrice, isLaunchPrice, launchHoursLeft } from './pricing.js';

/**
 * Drop announcement messages. Both are sent by the bot (the channel post too), so both follow
 * the bot rule: Stars only, no TON prices and no links to the web checkout.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function priceText(book) {
  const p = starsPrice(book);
  return isLaunchPrice(book) ? `⭐ ${p} Stars for the next ${launchHoursLeft(book)}h (then ${book.full_stars})` : `⭐ ${p} Stars`;
}

/** Channel post: buttons are URL deep links into the bot, where checkout happens in Stars. */
export function channelPost(book, cfg) {
  const deep = (payload) => `https://t.me/${cfg.botUsername}?start=${payload}`;
  return {
    text: `🔥 <b>New drop: ${esc(book.title)}</b>\n\n${esc(book.pitch)}\n\n${priceText(book)}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: `Buy in Telegram · ${starsPrice(book)} ⭐`, url: deep(`buy_${book.id}`) }],
        [{ text: '🎁 Free chapter', url: deep(`sample_${book.id}`) }],
      ],
    },
  };
}

/** DM to opted-in subscribers. */
export function alertMessage(book) {
  return {
    text: `🔔 <b>New drop: ${esc(book.title)}</b>\n${esc(book.pitch)}\n\n${priceText(book)}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: `Buy · ${starsPrice(book)} ⭐`, callback_data: `buy:${book.id}` }, { text: '🎁 Free chapter', callback_data: `sample:${book.id}` }],
        [{ text: '🔕 Stop drop alerts', callback_data: 'alerts:off' }],
      ],
    },
  };
}
