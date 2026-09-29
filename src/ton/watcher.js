// Polls the receiving wallet (toncenter v2 getTransactions) and marks TON orders paid when an
// incoming transfer carries the order id as its comment and at least the order amount.
export class TonWatcher {
  constructor({ store, config, fetchImpl = globalThis.fetch, log = console, onPaid = () => {} }) {
    this.store = store;
    this.cfg = config.ton;
    this.fetch = fetchImpl;
    this.log = log;
    this.onPaid = onPaid;
    this.timer = null;
  }

  async fetchTransactions(limit = 50) {
    const url = new URL(`${this.cfg.apiBase}/getTransactions`);
    url.searchParams.set('address', this.cfg.wallet);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('archival', 'true');
    const headers = this.cfg.apiKey ? { 'X-API-Key': this.cfg.apiKey } : {};
    const res = await this.fetch(url, { headers });
    const body = await res.json();
    if (!body.ok) throw new Error(`toncenter: ${body.error || res.status}`);
    return body.result;
  }

  /** Processes one batch of transactions; returns the orders that became paid. */
  processTransactions(txs) {
    const paid = [];
    for (const t of txs) {
      const hash = t.transaction_id?.hash;
      const lt = t.transaction_id?.lt;
      const msg = t.in_msg;
      if (!hash || this.store.hasSeenTx(hash)) continue;
      if (!msg || !msg.source) continue; // external/outgoing only — nothing to match, and not yet final to mark
      const comment = (msg.message || '').trim();
      const value = BigInt(msg.value || '0');
      const order = /^DS-[A-Z0-9]{10}$/.test(comment) ? this.store.getTonOrder(comment) : null;

      if (!order) {
        this.store.markTxSeen(hash, lt, null, comment ? 'no matching order' : 'no comment');
        continue;
      }
      if (order.status === 'paid' || order.status === 'refunded') {
        this.store.markTxSeen(hash, lt, order.id, 'duplicate payment for settled order');
        this.log.warn?.(`[ton] duplicate transfer ${hash} for ${order.id}; refund manually if needed`);
        continue;
      }
      if (value < BigInt(order.amount_nano)) {
        this.store.markTxSeen(hash, lt, order.id, `underpaid ${value}`);
        this.log.warn?.(`[ton] underpaid transfer ${hash} for ${order.id}: ${value} < ${order.amount_nano}`);
        continue;
      }
      if (this.store.markTonOrderPaid(order.id, { txHash: hash, sender: msg.source, paidNano: value })) {
        paid.push(this.store.getTonOrder(order.id));
      }
      this.store.markTxSeen(hash, lt, order.id, 'paid');
    }
    return paid;
  }

  async tick() {
    this.store.expireTonOrders();
    const txs = await this.fetchTransactions();
    // Oldest first, so a duplicate payment never settles an order ahead of the original.
    const paid = this.processTransactions([...txs].reverse());
    for (const order of paid) {
      this.log.info?.(`[ton] order ${order.id} paid by ${order.sender} (${order.tx_hash})`);
      await this.onPaid(order);
    }
    return paid;
  }

  start() {
    if (!this.cfg.wallet) {
      this.log.warn?.('[ton] TON_WALLET_ADDRESS not set; watcher disabled');
      return;
    }
    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        this.log.error?.(`[ton] watcher error: ${err.message}`);
      }
      this.timer = setTimeout(loop, this.cfg.pollSeconds * 1000);
    };
    loop();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
