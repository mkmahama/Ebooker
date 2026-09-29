// Operator CLI. The bot exposes only its seven public commands; shop admin happens here.
import { createApp } from '../src/app.js';
import { starsPrice, formatTon } from '../src/pricing.js';

const USAGE = `Usage: npm run admin -- <command> [args]

  books                       List products with current Stars and TON prices
  launch <slug> [--no-announce]
                              Make <slug> the current drop, start its 48h launch price,
                              alert opted-in users and post to the channel
  announce <slug>             Re-send the drop alert and channel post
  set <slug> <field> <value>  Edit a book (active, reader_group_url, launch_price_stars,
                              full_price_stars, launch_ends_at, is_current_drop)
  end-launch <slug>           Switch <slug> to full price now
  refund <charge_id>          Refund a Stars purchase via refundStarPayment and notify the user
  user <telegram_user_id>     Show a user's record and purchases
  orders [n]                  Show the latest TON web orders
  stats                       Funnel metrics (sample->purchase, Stars vs TON, referrals, refunds, opt-ins)
  set-commands                Register the seven bot commands with Telegram
`;

const [cmd, ...args] = process.argv.slice(2);
const app = createApp();
const { store, bot, config, api, pricer } = app;
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const need = (v, name) => { if (!v) { console.error(`missing ${name}\n\n${USAGE}`); process.exit(1); } return v; };
const book = (slug) => store.getBookBySlug(slug) || (console.error(`unknown book ${slug}`), process.exit(1));

switch (cmd) {
  case 'books':
    await pricer.refreshRate();
    for (const b of store.db.prepare('SELECT * FROM books ORDER BY sort_order').all().map((r) => store.getBook(r.id))) {
      out(`${b.active ? ' ' : 'x'}${b.is_current_drop ? '*' : ' '} ${b.slug.padEnd(28)} ${String(starsPrice(b)).padStart(4)}⭐  ${formatTon(pricer.priceNano(b)).padStart(6)} TON  launch ends: ${b.launch_ends_at ? new Date(b.launch_ends_at).toISOString() : 'not started'}`);
    }
    break;
  case 'launch': {
    const b = store.startDrop(book(need(args[0], 'slug')).slug, config.pricing.launchHours);
    out(`${b.slug} is the current drop; launch price ${b.launch_price_stars}⭐ until ${new Date(b.launch_ends_at).toISOString()}`);
    if (!args.includes('--no-announce')) out(await bot.announceDrop(b, { webUrl: `${config.publicUrl}/book/${b.slug}` }));
    break;
  }
  case 'announce':
    out(await bot.announceDrop(book(need(args[0], 'slug')), { webUrl: `${config.publicUrl}/book/${args[0]}` }));
    break;
  case 'set': {
    const [slug, field, value] = args;
    need(value, 'value');
    const v = value === 'null' ? null : /^\d+$/.test(value) ? Number(value) : value;
    out(store.setBookField(book(slug).slug, field, v));
    break;
  }
  case 'end-launch':
    out(store.setBookField(book(need(args[0], 'slug')).slug, 'launch_ends_at', Date.now()));
    break;
  case 'refund': {
    const p = await bot.refund(need(args[0], 'charge_id'));
    out(`Refunded ${p.stars_paid}⭐ to ${p.telegram_user_id} (${args[0]})`);
    break;
  }
  case 'user':
    out(store.getUserProfile(Number(need(args[0], 'telegram_user_id'))) || 'not found');
    break;
  case 'orders':
    out(store.db.prepare(`SELECT id, status, book_id, amount_nano, tx_hash, claimed_by, datetime(created_at/1000, 'unixepoch') AS created FROM ton_orders ORDER BY created_at DESC LIMIT ?`).all(Number(args[0] || 20)));
    break;
  case 'stats':
    out(store.metrics());
    break;
  case 'set-commands':
    out(await api.call('setMyCommands', { commands: (await import('../src/bot/bot.js')).COMMANDS }));
    break;
  default:
    out(USAGE);
}
