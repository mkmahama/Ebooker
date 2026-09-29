import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, expiring download links: HMAC-SHA256 over order, book, format and expiry.
export function signDownload(secret, { orderId, bookId, format, exp }) {
  if (!secret) throw new Error('DOWNLOAD_SECRET is not set');
  return createHmac('sha256', secret).update(`${orderId}|${bookId}|${format}|${exp}`).digest('base64url');
}

export function verifyDownload(secret, { orderId, bookId, format, exp, sig }, at = Date.now()) {
  if (!sig || !exp || Number(exp) * 1000 < at) return false;
  const expected = Buffer.from(signDownload(secret, { orderId, bookId, format, exp: Number(exp) }));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && timingSafeEqual(expected, given);
}
