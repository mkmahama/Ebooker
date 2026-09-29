/**
 * Manage drops and announce them.
 *   npm run drop -- list
 *   npm run drop -- launch <book-id> [--hours 48] [--announce]   start the launch-price window, feature it
 *   npm run drop -- announce <book-id> [--channel-only | --alerts-only]
 *   npm run drop -- hide <book-id> | show <book-id>
 *
 * Channel posts and alerts are both sent by the bot, so neither mentions TON or links the web
 * checkout: inside Telegram everything is paid in Stars (Telegram's digital-goods rule).
 * Promote the TON web page from your own site or socials instead.
 */
import fs from 'node:fs';
import { boot, flag, sleep } from './_lib.js';
import { starsPrice, isLaunchPrice, launchHoursLeft, tonPriceNano, formatTon } from '../src/pricing.js';
import { channelPost, alertMessage } from '../src/announce.js';
import { coverFile } from '../src/content.js';

const [cmd, bookId] = process.argv.slice(2);
const args = process.argv.slice(2);
const { cfg, db, api } = boot({ needBot: cmd === 'announce' || !!flag(args, 'announce', false) });

function requireBook() {
  const book = bookId && db.getBook(bookId);
  if (!book) { console.error(`Unknown book id "${bookId}". Run: npm run drop -- list`); process.exit(1); }
  return book;
}

async function postToChannel(book) {
  if (!cfg.channelId) { console.warn('CHANNEL_ID not set; skipping channel post.'); return; }
  const { text, reply_markup } = channelPost(book, cfg);
  const cover = coverFile(cfg, book.id);
  if (cover) await api.call('sendPhoto', { chat_id: cfg.channelId, photo: { file: cover }, caption: text, parse_mode: 'HTML', reply_markup });
  else await api.call('sendMessage', { chat_id: cfg.channelId, text, parse_mode: 'HTML', reply_markup });
  console.log(`Posted to channel ${cfg.channelId}.`);
}

async function alertSubscribers(book) {
  const ids = db.listAlertSubscribers();
  let sent = 0; let dropped = 0;
  const { text, reply_markup } = alertMessage(book);
  for (const id of ids) {
    if (db.ownsBook(id, book.id)) continue;
    try {
      await api.call('sendMessage', { chat_id: id, text, parse_mode: 'HTML', reply_markup });
      sent++;
    } catch (e) {
      if (e.code === 403) { db.setAlertOptIn(id, false); dropped++; } else console.warn(`alert to ${id} failed: ${e.message}`);
    }
    await sleep(50); // stay under ~20 messages/second
  }
  console.log(`Alerted ${sent} subscriber(s); ${dropped} had blocked the bot and were unsubscribed.`);
}

switch (cmd) {
  case 'list': {
    for (const b of db.raw.prepare('SELECT * FROM books ORDER BY drop_number').all()) {
      console.log(`${b.featured ? '*' : ' '} #${b.drop_number} ${b.id.padEnd(24)} ${b.status.padEnd(6)} ${String(starsPrice(b)).padStart(4)}⭐  ${formatTon(tonPriceNano(b, cfg)).padStart(6)} TON  ${isLaunchPrice(b) ? `launch ${launchHoursLeft(b)}h left` : ''}`);
    }
    const hasFiles = (id) => ['epub', 'pdf'].every((f) => fs.existsSync(`${cfg.contentDir}/books/${id}/book.${f}`));
    const missing = db.listLiveBooks().filter((b) => !hasFiles(b.id)).map((b) => b.id);
    if (missing.length) console.log(`\n⚠️  Missing EPUB/PDF for: ${missing.join(', ')}`);
    break;
  }
  case 'launch': {
    const book = requireBook();
    const hours = Number(flag(args, 'hours', 48));
    db.startLaunch(book.id, hours);
    console.log(`${book.id} is the current drop; launch price ${book.launch_stars}⭐ for ${hours}h, then ${book.full_stars}⭐.`);
    if (flag(args, 'announce', false)) {
      const fresh = db.getBook(book.id);
      await postToChannel(fresh);
      await alertSubscribers(fresh);
    }
    break;
  }
  case 'announce': {
    const book = requireBook();
    if (!flag(args, 'alerts-only', false)) await postToChannel(book);
    if (!flag(args, 'channel-only', false)) await alertSubscribers(book);
    break;
  }
  case 'hide':
  case 'show': {
    const book = requireBook();
    db.setBookStatus(book.id, cmd === 'hide' ? 'hidden' : 'live');
    console.log(`${book.id} is now ${cmd === 'hide' ? 'hidden' : 'live'}.`);
    break;
  }
  default:
    console.log('Usage: npm run drop -- list | launch <id> [--hours 48] [--announce] | announce <id> [--channel-only|--alerts-only] | hide <id> | show <id>');
}
db.close();
