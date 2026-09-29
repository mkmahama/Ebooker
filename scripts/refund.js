/**
 * Refund a Stars purchase.
 *   npm run refund -- <telegram_payment_charge_id | purchase id> [--quiet]
 * Calls refundStarPayment, marks the purchase refunded (removes it from /library)
 * and tells the buyer unless --quiet is passed.
 */
import { boot, flag } from './_lib.js';

const args = process.argv.slice(2);
const ref = args.find((a) => !a.startsWith('--'));
if (!ref) {
  console.error('Usage: npm run refund -- <charge_id | purchase_id> [--quiet]');
  process.exit(1);
}

const { db, api } = boot();
const purchase = /^\d+$/.test(ref) ? db.getPurchase(Number(ref)) : db.getPurchaseByCharge(ref);
if (!purchase) { console.error(`No purchase found for ${ref}`); process.exit(1); }
if (purchase.method !== 'stars' || !purchase.charge_id) {
  console.error(`Purchase ${purchase.id} was paid by ${purchase.method}; only Stars payments refund through the Bot API. Refund TON manually from the wallet.`);
  process.exit(1);
}
if (purchase.refunded_at) { console.error(`Purchase ${purchase.id} is already refunded.`); process.exit(1); }

try {
  await api.call('refundStarPayment', { user_id: purchase.telegram_user_id, telegram_payment_charge_id: purchase.charge_id });
} catch (e) {
  console.error(`Telegram refused the refund: ${e.message}`);
  process.exit(1);
}
db.markRefunded(purchase.id);
const book = db.getBook(purchase.book_id);
console.log(`Refunded ${purchase.stars_paid} Stars to user ${purchase.telegram_user_id} for ${purchase.book_id} (purchase ${purchase.id}).`);
if (!flag(args, 'quiet', false)) {
  await api.call('sendMessage', {
    chat_id: purchase.telegram_user_id,
    text: `↩️ Your ${purchase.stars_paid} Stars for "${book?.title ?? purchase.book_id}" were refunded. The book was removed from your library.`,
  }).catch((e) => console.warn(`Could not message the buyer: ${e.message}`));
}
db.close();
