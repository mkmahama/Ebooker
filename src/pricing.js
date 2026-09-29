// Stars prices follow the drop's launch window; TON prices are derived from the Stars price,
// discounted because TON sales skip the app stores' cut.

export function starsPrice(book, at = Date.now()) {
  const launch = book.launch_ends_at === null || book.launch_ends_at === undefined || at < book.launch_ends_at;
  return launch ? book.launch_price_stars : book.full_price_stars;
}

export function isLaunchPrice(book, at = Date.now()) {
  return book.launch_price_stars !== book.full_price_stars && starsPrice(book, at) === book.launch_price_stars;
}

const NANO = 1_000_000_000n;

/** Formats nanotons as a TON string, e.g. 1150000000n -> "1.15". */
export function formatTon(nano) {
  const n = BigInt(nano);
  const whole = n / NANO;
  const frac = (n % NANO).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export class TonPricer {
  constructor(cfg, { fetchImpl = globalThis.fetch, log = console } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.log = log;
    this.tonUsd = cfg.tonUsd;
    this.updatedAt = 0;
  }

  /** In usd_peg mode, refreshes TON/USD from the configured rate URL (falls back to the last known rate). */
  async refreshRate() {
    if (this.cfg.pricingMode !== 'usd_peg') return this.tonUsd;
    try {
      const res = await this.fetch(this.cfg.rateUrl);
      const body = await res.json();
      const rate = Number(body?.rates?.TON?.prices?.USD);
      if (!(rate > 0)) throw new Error('rate missing from response');
      this.tonUsd = rate;
      this.updatedAt = Date.now();
    } catch (err) {
      this.log.warn?.(`[pricing] TON/USD refresh failed, keeping ${this.tonUsd}: ${err.message}`);
    }
    return this.tonUsd;
  }

  /** TON price in nanotons for a Stars price, rounded up to 0.01 TON. */
  nanoForStars(stars) {
    const usd = stars * this.cfg.starUsd * (1 - this.cfg.discount);
    const ton = usd / this.tonUsd;
    const cents = Math.max(1, Math.ceil(ton * 100 - 1e-9));
    return BigInt(cents) * 10_000_000n;
  }

  priceNano(book, at = Date.now()) {
    return this.nanoForStars(starsPrice(book, at));
  }
}
