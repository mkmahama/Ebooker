/* Drop Shelf web checkout: TON Connect transfer with the order id as comment, then poll for payment. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const STORAGE_KEY = 'dropshelf.orders';
  let cfg, tonConnectUI, pollTimer;

  const store = {
    load() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } },
    save(list) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-10))); } catch {} },
    add(o) { this.save([...this.load().filter((x) => x.orderId !== o.orderId), { orderId: o.orderId, accessToken: o.accessToken }]); },
  };

  const api = async (path, init) => {
    const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  };

  const el = (tag, props = {}, ...children) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const c of children) n.append(c);
    return n;
  };

  async function init() {
    cfg = await api('/api/config');
    if (cfg.discountPercent) $('#discount-note').textContent = `About ${cfg.discountPercent}% less than in-app prices.`;
    try {
      tonConnectUI = new TON_CONNECT_UI.TonConnectUI({ manifestUrl: cfg.manifestUrl, buttonRootId: 'ton-connect' });
    } catch {
      tonConnectUI = null; // wallet script blocked or offline: manual payment still works
    }
    await renderBooks();
    // Resume the latest unfinished order (e.g. after the wallet app switched back to the browser).
    const last = store.load().at(-1);
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('order') && params.get('token') ? { orderId: params.get('order'), accessToken: params.get('token') } : null;
    if (fromUrl || last) showOrder(fromUrl || last, false);
  }

  async function renderBooks() {
    const { books } = await api('/api/books');
    const root = $('#books');
    root.textContent = '';
    const focus = location.pathname.startsWith('/book/') ? location.pathname.slice(6) : null;
    for (const b of books) {
      const node = $('#book-tpl').content.firstElementChild.cloneNode(true);
      $('h3', node).textContent = b.title;
      $('.pitch', node).textContent = b.pitch;
      $('.audience', node).textContent = b.audience ? `For: ${b.audience}` : '';
      $('.badge', node).hidden = !b.isCurrentDrop;
      if (b.hasCover) $('.cover', node).style.backgroundImage = `url(/covers/${b.slug})`;
      $('.price', node).append(`${b.tonPrice} TON`);
      const btn = $('.pay', node);
      btn.disabled = !cfg.walletConfigured;
      btn.addEventListener('click', () => buy(b, btn));
      root.append(node);
      if (b.slug === focus) node.scrollIntoView({ block: 'center' });
    }
  }

  async function ensureWallet() {
    if (!tonConnectUI) return false;
    await tonConnectUI.connectionRestored;
    if (tonConnectUI.connected) return true;
    await tonConnectUI.openModal();
    return new Promise((resolve) => {
      const off = tonConnectUI.onStatusChange((w) => { if (w) { off(); resolve(true); } });
      const offModal = tonConnectUI.onModalStateChange?.((s) => {
        if (s.status === 'closed' && !tonConnectUI.connected) { offModal?.(); off(); resolve(false); }
      });
    });
  }

  async function buy(book, btn) {
    btn.disabled = true;
    try {
      const walletReady = await ensureWallet();
      if (!walletReady && tonConnectUI) return; // user closed the wallet picker
      const order = await api('/api/orders', { method: 'POST', body: JSON.stringify({ slug: book.slug }) });
      store.add(order);
      showOrder(order, true);
      if (!walletReady) return; // no TON Connect: the page shows manual payment details
      try {
        await tonConnectUI.sendTransaction({
          validUntil: order.validUntil,
          network: cfg.network === 'testnet' ? '-3' : '-239',
          messages: [{ address: order.address, amount: order.amountNano, payload: order.payload }],
        });
        setStatus('Transfer sent. Waiting for it to confirm on-chain (usually under a minute)…');
      } catch (err) {
        setStatus('The wallet did not send the transfer. You can retry, or pay manually with the details above.', 'warn');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function setStatus(text, kind = '') {
    const s = $('#co-status');
    if (s) { s.textContent = text; s.className = `status ${kind}`; }
  }

  function showOrder(ref, scroll) {
    clearTimeout(pollTimer);
    const section = $('#checkout');
    section.hidden = false;
    if (scroll) section.scrollIntoView({ behavior: 'smooth' });
    const poll = async () => {
      let o;
      try {
        o = await api(`/api/orders/${encodeURIComponent(ref.orderId)}?token=${encodeURIComponent(ref.accessToken)}`);
      } catch (err) {
        section.hidden = true; // unknown or foreign order: forget it
        store.save(store.load().filter((x) => x.orderId !== ref.orderId));
        return;
      }
      renderOrder(o, ref);
      if (o.status !== 'paid') pollTimer = setTimeout(poll, 5000);
    };
    poll();
  }

  function renderOrder(o, ref) {
    $('#co-title').textContent = o.status === 'paid' ? `Paid: ${o.book.title}` : `Order ${o.orderId}: ${o.book.title}`;
    const body = $('#co-body');
    const prevStatus = $('#co-status')?.textContent;
    body.textContent = '';
    if (o.status !== 'paid') {
      body.append(el('dl', { className: 'kv' },
        el('dt', {}, 'Amount'), el('dd', {}, el('code', {}, `${o.amountTon} TON`)),
        el('dt', {}, 'To'), el('dd', {}, el('code', {}, o.address)),
        el('dt', {}, 'Comment'), el('dd', {}, el('code', {}, o.comment)),
      ));
      body.append(el('p', { className: 'muted' }, 'Paying manually? Send exactly this amount to this address with this comment.'));
      body.append(el('p', { id: 'co-status', className: 'status' }, o.note || prevStatus || 'Waiting for payment…'));
      return;
    }
    body.append(el('p', { id: 'co-status', className: 'status ok' }, 'Payment confirmed. Your downloads are ready.'));
    const list = el('ul', { className: 'downloads' });
    for (const d of o.downloads) {
      list.append(el('li', {}, el('a', { href: d.url, rel: 'nofollow' }, `${d.title} (${d.format.toUpperCase()})`)));
    }
    body.append(list);
    const hours = Math.round((o.downloadsExpireAt - Date.now()) / 3600000);
    body.append(el('p', { className: 'muted' }, `Links expire in about ${hours} hours. Bookmark this page to get fresh links later: `,
      el('a', { href: `/?order=${encodeURIComponent(ref.orderId)}&token=${encodeURIComponent(ref.accessToken)}` }, 'order link'), '.'));
    body.append(el('dl', { className: 'kv' }, el('dt', {}, 'Transaction'), el('dd', {}, el('code', {}, o.txHash))));
    if (o.claimUrl) {
      body.append(el('div', { className: 'actions' },
        el('a', { href: o.claimUrl, target: '_blank', rel: 'noopener' }, el('button', { className: 'secondary', type: 'button' }, 'Claim in Telegram (adds it to your library)'))));
    }
  }

  init().catch((err) => { $('#books').textContent = `Could not load the shelf: ${err.message}`; });
})();
