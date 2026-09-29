import crypto from 'node:crypto';

/**
 * Signed, expiring download links for web (TON) buyers.
 * Token = base64url(JSON {o: orderId, b: bookId, f: format, e: expiry}) + "." + HMAC-SHA256.
 */
export function signDownload(cfg, { orderId, bookId, format }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    o: orderId, b: bookId, f: format, e: Math.floor(now / 1000) + cfg.linkTtlMinutes * 60,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', cfg.linkSecret).update(body).digest('base64url');
  return `${cfg.publicUrl}/dl/${body}.${sig}`;
}

/** Returns the claims, or null if the token is forged, malformed or expired. */
export function verifyDownload(cfg, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', cfg.linkSecret).update(body).digest('base64url'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims.e !== 'number' || claims.e < Math.floor(now / 1000)) return null;
  return { orderId: claims.o, bookId: claims.b, format: claims.f, expiresAt: claims.e };
}
