// Builds the TON Connect `payload` for a transfer with a text comment: a single cell holding
// op = 0 (32 bits) followed by the UTF-8 comment, serialized as a bag of cells (BOC), base64.
// Implemented by hand so the checkout needs no TON SDK; verified against @ton/core in tests.

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC32C_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const MAX_COMMENT_BYTES = 123; // (1023 bits - 32-bit op) / 8, rounded down

export function commentPayloadBoc(comment) {
  const text = Buffer.from(comment, 'utf8');
  if (text.length > MAX_COMMENT_BYTES) throw new Error('comment too long for a single cell');
  const data = Buffer.concat([Buffer.alloc(4), text]); // op 0x00000000 + text
  // Cell: d1 (refs=0, not exotic, level 0), d2 = 2 * bytes (bit length is byte-aligned), data.
  const cell = Buffer.concat([Buffer.from([0, data.length * 2]), data]);
  const header = Buffer.from([
    0xb5, 0xee, 0x9c, 0x72, // generic BOC magic
    0x41,                   // has_crc32c, size_bytes = 1
    0x01,                   // offset bytes = 1
    0x01, 0x01, 0x00,       // cells = 1, roots = 1, absent = 0
    cell.length,            // total cells size
    0x00,                   // root index
  ]);
  const body = Buffer.concat([header, cell]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32c(body));
  return Buffer.concat([body, crc]).toString('base64');
}
