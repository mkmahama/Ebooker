import { formatTon } from '../pricing.js';
import { commentPayloadBoc } from './comment.js';
import { signDownload } from '../web/signing.js';

// Web checkout orders paid in TON. The order id is the transfer comment; the access token
// (never on-chain) is required to read an order's status and download links.
export class TonOrders {
  constructor({ store, pricer, config }) {
    this.store = store;
    this.pricer = pricer;
    this.config = config;
  }

  create(slug) {
    const book = this.store.getBookBySlug(slug);
    if (!book || !book.active) return null;
    const amountNano = this.pricer.priceNano(book);
    const order = this.store.createTonOrder({ bookId: book.id, amountNano, ttlMinutes: this.config.ton.orderTtlMinutes });
    return {
      orderId: order.id,
      accessToken: order.access_token,
      book: { slug: book.slug, title: book.title },
      amountNano: order.amount_nano,
      amountTon: formatTon(order.amount_nano),
      address: this.config.ton.wallet,
      comment: order.id,
      payload: commentPayloadBoc(order.id),
      validUntil: Math.floor(Date.now() / 1000) + 15 * 60,
      expiresAt: order.expires_at,
    };
  }

  /** Public status for the page. Download links and the claim link appear only once paid. */
  status(orderId, accessToken, at = Date.now()) {
    const order = this.store.getTonOrder(orderId);
    if (!order || order.access_token !== accessToken) return null;
    const book = this.store.getBook(order.book_id);
    const out = {
      orderId: order.id,
      status: order.status,
      book: { slug: book.slug, title: book.title },
      amountTon: formatTon(order.amount_nano),
      address: this.config.ton.wallet,
      comment: order.id,
    };
    if (order.status === 'expired') out.note = 'Order window closed. If you already sent the transfer, it will still be matched.';
    if (order.status !== 'paid') return out;

    const exp = Math.floor(at / 1000) + this.config.downloads.ttlHours * 3600;
    out.txHash = order.tx_hash;
    out.downloadsExpireAt = exp * 1000;
    out.downloads = [];
    for (const id of this.store.unlockedBookIds(book)) {
      const b = this.store.getBook(id);
      for (const format of ['epub', 'pdf']) {
        const sig = signDownload(this.config.downloads.secret, { orderId: order.id, bookId: b.id, format, exp });
        out.downloads.push({
          title: b.title,
          format,
          url: `${this.config.publicUrl}/download/${encodeURIComponent(order.id)}/${b.id}/${format}?exp=${exp}&sig=${sig}`,
        });
      }
    }
    out.claimUrl = order.claimed_by ? null : `https://t.me/${this.config.bot.username}?start=claim_${order.claim_token}`;
    return out;
  }
}
