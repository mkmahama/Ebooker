/** Pricing rules shared by the bot and the web checkout. */

const NANO = 1_000_000_000n;

export function isLaunchPrice(book, at = Date.now() / 1000) {
  return !!book.launch_ends_at && at < book.launch_ends_at;
}

/** Current price in Stars (launch price inside the launch window, full price otherwise). */
export function starsPrice(book, at = Date.now() / 1000) {
  return isLaunchPrice(book, at) ? book.launch_stars : book.full_stars;
}

/**
 * TON price in nanotons: Stars price x TON per Star, minus the web discount,
 * rounded up to 0.01 TON so wallets show a clean amount.
 */
export function tonPriceNano(book, cfg, at = Date.now() / 1000) {
  const ton = starsPrice(book, at) * cfg.tonPerStar * (1 - cfg.tonDiscount);
  const hundredths = BigInt(Math.max(1, Math.ceil(ton * 100 - 1e-9)));
  return hundredths * (NANO / 100n);
}

export function formatTon(nano) {
  const n = BigInt(nano);
  const whole = n / NANO;
  const frac = (n % NANO).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function launchHoursLeft(book, at = Date.now() / 1000) {
  return isLaunchPrice(book, at) ? Math.max(1, Math.ceil((book.launch_ends_at - at) / 3600)) : 0;
}
