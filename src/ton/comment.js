/**
 * Encodes a TON text comment ("op = 0" + UTF-8 text) as a single-cell bag-of-cells,
 * base64, for the `payload` field of a TON Connect sendTransaction message.
 * Equivalent to @ton/core: beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().
 * One cell holds up to 1023 bits, so comments are limited to 123 bytes (order ids are ~11).
 */

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC32C_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function commentPayloadBoc(text) {
  const data = Buffer.concat([Buffer.alloc(4), Buffer.from(text, 'utf8')]); // 32-bit zero op + text
  if (data.length > 127) throw new Error('comment too long for one cell (max 123 bytes)');
  const d1 = 0; // no refs, ordinary cell, level 0
  const d2 = data.length * 2; // byte-aligned: ceil(bits/8) + floor(bits/8)
  const cell = Buffer.concat([Buffer.from([d1, d2]), data]);
  const header = Buffer.from([
    0xb5, 0xee, 0x9c, 0x72, // serialized_boc magic
    0x41, // has_idx=0, has_crc32c=1, has_cache_bits=0, flags=0, size_bytes=1
    0x01, // off_bytes = 1
    0x01, // cells = 1
    0x01, // roots = 1
    0x00, // absent = 0
    cell.length, // tot_cells_size
    0x00, // root index 0
  ]);
  const body = Buffer.concat([header, cell]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32c(body));
  return Buffer.concat([body, crc]).toString('base64');
}

/** Inverse of commentPayloadBoc for this exact layout (used in tests and debugging). */
export function decodeCommentBoc(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.readUInt32BE(0) !== 0xb5ee9c72) throw new Error('bad magic');
  const body = buf.subarray(0, buf.length - 4);
  if (crc32c(body) !== buf.readUInt32LE(buf.length - 4)) throw new Error('bad crc');
  const d2 = buf[12];
  const data = buf.subarray(13, 13 + d2 / 2);
  if (data.readUInt32BE(0) !== 0) throw new Error('not a text comment');
  return data.subarray(4).toString('utf8');
}
