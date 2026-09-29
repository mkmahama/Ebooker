/* Drop Shelf web checkout: TON Connect transfer with a prefilled order comment, then poll until the watcher confirms. */
(() => {
  const $ = (id) => document.getElementById(id);
  const CHAIN = { mainnet: '-239', testnet: '-3' };
  const STORE_KEY = 'dropshelf:lastOrder';
  let network = 'testnet';
  let books = [];
  let current = null; // { book, order, key }
  let pollTimer = null;

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } },
    set(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } },
  };

  let tc = null;
  try {
    tc = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl: `${location.origin}/tonconnect-manifest.json`,
      buttonRootId: 'ton-connect',
    });
  } catch (e) {
    console.warn('TON Connect failed to load; manual payment only.', e);
  }

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'onclick') n.addEventListener('click', v);
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  }

  function renderBooks() {
    const root = $('books');
    root.replaceChildren();
    if (!books.length) { root.append(el('p', { class: 'muted' }, 'New drops are on the way.')); return; }
    for (const b of books) {
      const badges = (b.featured || b.launch) ? el('div', { class: 'badges' },
        b.featured ? el('span', { class: 'badge hot' }, 'Current drop') : null,
        b.launch ? el('span', { class: 'badge' }, `Launch price · ${b.launchHoursLeft}h left`) : null) : null;
      const card = el('article', { class: `card${b.featured ? ' featured' : ''}` },
        badges,
        el('h3', {}, b.title),
        el('p', {}, b.pitch),
        el('div', { class: 'price-row' },
          el('span', { class: 'price' }, b.ton, ' ', el('span', { class: 'unit' }, 'TON'))),
        el('button', { class: 'btn', type: 'button', onclick: () => startCheckout(b) }, 'Pay with TON'),
        el('span', { class: 'alt' }, 'or ', el('a', { href: b.botLink, target: '_blank', rel: 'noopener' }, `buy in Telegram for ${b.stars} ⭐`)));
      root.append(card);
    }
  }

  function setStep(step, state) { const n = $(`st-${step}`); n.classList.remove('active', 'done'); if (state) n.classList.add(state); }
  function msg(text, kind = '') { const m = $('co-msg'); m.textContent = text; m.className = `co-msg ${kind}`; }
  function actions(...nodes) { $('co-actions').replaceChildren(...nodes); }

  function openDialog(book, amountTon) {
    $('co-book').textContent = book.title;
    $('co-ton').textContent = amountTon;
    $('co-id').textContent = '—';
    $('co-manual').hidden = true;
    ['connect', 'confirm', 'wait'].forEach((s) => setStep(s, null));
    msg(''); actions();
    const d = $('checkout');
    if (!d.open) d.showModal();
  }

  function waitForWallet() {
    return new Promise((resolve) => {
      if (tc.connected) return resolve();
      const off = tc.onStatusChange((w) => { if (w) { off(); resolve(); } });
      tc.openModal();
    });
  }

  async function createOrder(book) {
    const res = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bookId: book.id }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not create the order.');
    return body;
  }

  function showManual(order) {
    const m = order.transaction.messages[0];
    $('mn-amount').textContent = order.amountTon;
    $('mn-address').textContent = m.address;
    $('mn-comment').textContent = order.orderId;
    $('co-manual').hidden = false;
  }

  async function startCheckout(book) {
    stopPolling();
    openDialog(book, book.ton);
    try {
      if (tc) {
        setStep('connect', 'active');
        msg('Connect your TON wallet to continue.');
        await waitForWallet();
        setStep('connect', 'done');
      }
      const order = await createOrder(book);
      current = { book, order, key: order.key };
      store.set({ orderId: order.orderId, key: order.key, bookId: book.id, at: Date.now() });
      $('co-id').textContent = order.orderId;
      $('co-ton').textContent = order.amountTon;
      showManual(order);
      if (tc) await sendTransfer(); else { $('co-manual').open = true; msg('Send the transfer manually using the details below.'); setStep('wait', 'active'); poll(); }
    } catch (e) {
      msg(e.message || 'Something went wrong.', 'warn');
      actions(el('button', { class: 'btn', type: 'button', onclick: () => startCheckout(book) }, 'Try again'));
    }
  }

  async function sendTransfer() {
    const { order } = current;
    setStep('confirm', 'active');
    msg('Confirm the transfer in your wallet.');
    actions();
    try {
      await tc.sendTransaction({ ...order.transaction, network: CHAIN[network] });
      setStep('confirm', 'done');
      setStep('wait', 'active');
      msg('Transfer sent. Waiting for it to land on-chain, usually under a minute…');
      poll();
    } catch (e) {
      setStep('confirm', null);
      msg('The transfer was not sent. You can retry; the same order stays open.', 'warn');
      actions(el('button', { class: 'btn', type: 'button', onclick: sendTransfer }, 'Retry transfer'));
      poll(); // in case it was sent from another device
    }
  }

  function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }

  function poll() {
    stopPolling();
    const tick = async () => {
      try {
        const res = await fetch(`/api/orders/${current.order.orderId}`, { headers: { 'x-order-key': current.key }, cache: 'no-store' });
        if (res.ok) {
          const o = await res.json();
          if (o.status === 'paid') return showPaid(o);
          if (o.status === 'underpaid') {
            setStep('wait', null);
            msg(`We received ${o.receivedTon} TON, less than ${o.amountTon}. Message our bot with /paysupport and quote order ${o.orderId}.`, 'warn');
            return;
          }
          if (o.status === 'expired') msg('This order expired. If you already sent the transfer, keep this page open; late payments are still credited.', 'warn');
        }
      } catch { /* network blip; keep polling */ }
      pollTimer = setTimeout(tick, 4000);
    };
    tick();
  }

  function showPaid(o) {
    stopPolling();
    ['connect', 'confirm', 'wait'].forEach((s) => setStep(s, 'done'));
    $('co-manual').hidden = true;
    msg('Payment received. Your book is ready.', 'good');
    const nodes = [
      el('a', { class: 'btn', href: o.downloads.epub }, 'Download EPUB'),
      el('a', { class: 'btn', href: o.downloads.pdf }, 'Download PDF'),
    ];
    if (o.claimUrl) nodes.push(el('a', { class: 'btn secondary', href: o.claimUrl, target: '_blank', rel: 'noopener' }, 'Add to my Telegram library'));
    nodes.push(el('p', { class: 'alt' }, `Links work for ${o.linkTtlMinutes} minutes. Reopen this page for fresh ones.`));
    actions(...nodes);
  }

  async function resumeLastOrder() {
    const last = store.get();
    if (!last || Date.now() - last.at > 24 * 3600 * 1000) return;
    try {
      const res = await fetch(`/api/orders/${last.orderId}`, { headers: { 'x-order-key': last.key }, cache: 'no-store' });
      if (!res.ok) { store.clear(); return; }
      const o = await res.json();
      const book = books.find((b) => b.id === last.bookId) || { id: last.bookId, title: o.book.title };
      current = { book, order: { orderId: o.orderId, amountTon: o.amountTon }, key: last.key };
      openDialog(book, o.amountTon);
      $('co-id').textContent = o.orderId;
      if (o.status === 'paid') showPaid(o);
      else { setStep('wait', 'active'); msg('Checking on your last order…'); poll(); }
    } catch { /* ignore */ }
  }

  $('checkout').addEventListener('close', stopPolling);

  fetch('/api/books').then((r) => r.json()).then((data) => {
    network = data.network;
    books = data.books;
    $('bot-link').href = data.bot;
    if (network === 'testnet') { const n = $('net-note'); n.textContent = 'Test mode: payments use the TON testnet.'; n.hidden = false; }
    renderBooks();
    resumeLastOrder();
  }).catch(() => { $('books').replaceChildren(el('p', { class: 'muted' }, 'The shelf could not load. Please refresh.')); });
})();
