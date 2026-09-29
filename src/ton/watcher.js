/**
 * Watches the receiving wallet through toncenter's v2 HTTP API and settles
 * orders whose transfer comment equals the order id and whose amount covers the price.
 */
const ORDER_RE = /^DS-[A-Z0-9]{8}$/;

export function toncenterBase(network) {
  return network === 'mainnet' ? 'https://toncenter.com/api/v2' : 'https://testnet.toncenter.com/api/v2';
}

/** Extract the text comment from a toncenter v2 in_msg. */
export function inMsgComment(inMsg) {
  if (!inMsg) return '';
  if (typeof inMsg.message === 'string' && inMsg.message) return inMsg.message;
  const d = inMsg.msg_data;
  if (d && d['@type'] === 'msg.dataText' && d.text) {
    try { return Buffer.from(d.text, 'base64').toString('utf8'); } catch { return ''; }
  }
  return '';
}

export function createWatcher({ db, cfg, fetchImpl = fetch, log = console, onEvent = async () => {} }) {
  const base = toncenterBase(cfg.tonNetwork);
  const headers = cfg.toncenterApiKey ? { 'X-API-Key': cfg.toncenterApiKey } : {};

  async function getTransactions({ lt, hash } = {}) {
    const params = new URLSearchParams({ address: cfg.tonReceiver, limit: '50', archival: 'true' });
    if (lt && hash) { params.set('lt', lt); params.set('hash', hash); }
    const res = await fetchImpl(`${base}/getTransactions?${params}`, { headers });
    if (!res.ok) throw new Error(`toncenter HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(`toncenter error: ${body.error}`);
    return body.result || [];
  }

  /** Newest-first pages until a seen transaction (or maxPages). Returns oldest-first unseen txs. */
  async function fetchUnseen(maxPages = 5) {
    const out = [];
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const txs = await getTransactions(cursor);
      let reachedSeen = false;
      for (const tx of txs) {
        if (cursor && tx.transaction_id.hash === cursor.hash) continue; // the cursor tx repeats on the next page
        if (db.isTxSeen(tx.transaction_id.hash)) { reachedSeen = true; break; }
        out.push(tx);
      }
      if (reachedSeen || txs.length < 50) break;
      const last = txs[txs.length - 1].transaction_id;
      cursor = { lt: last.lt, hash: last.hash };
    }
    return out.reverse();
  }

  async function pollOnce() {
    const expired = db.expireOrders();
    if (expired) log.info?.(`watcher: ${expired} order(s) expired`);
    if (!db.openOrderIds().length) return { processed: 0, settled: [] };

    const txs = await fetchUnseen();
    const settled = [];
    for (const tx of txs) {
      const { hash, lt } = tx.transaction_id;
      const inMsg = tx.in_msg;
      const comment = inMsgComment(inMsg).trim().toUpperCase();
      if (!inMsg?.source || !ORDER_RE.test(comment)) { db.markTxSeen(hash, lt); continue; }
      const order = db.getTonOrder(comment);
      if (!order) { db.markTxSeen(hash, lt); await onEvent({ type: 'unknown_order', comment, hash, value: inMsg.value }); continue; }
      if (order.status === 'paid' || order.status === 'underpaid') {
        db.markTxSeen(hash, lt);
        await onEvent({ type: 'extra_payment', order, hash, value: inMsg.value });
        continue;
      }
      const r = db.settleTonOrder({ orderId: order.id, txHash: hash, receivedNano: inMsg.value, lt });
      if (r.changed) {
        settled.push(r.order);
        await onEvent({ type: r.order.status, order: r.order, hash, value: inMsg.value });
      }
    }
    return { processed: txs.length, settled };
  }

  let timer = null;
  function start() {
    const tick = async () => {
      try { await pollOnce(); } catch (e) { log.error?.(`watcher: ${e.message}`); }
      timer = setTimeout(tick, cfg.watchIntervalSeconds * 1000);
    };
    tick();
    log.info?.(`watcher: polling ${cfg.tonNetwork} wallet every ${cfg.watchIntervalSeconds}s`);
  }
  function stop() { if (timer) clearTimeout(timer); timer = null; }

  return { pollOnce, start, stop, fetchUnseen };
}
