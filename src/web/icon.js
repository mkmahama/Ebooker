import { deflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

// A 180x180 PNG app icon for the TON Connect manifest (a shelf of three books), generated at startup.
export function iconPng(size = 180) {
  const bg = [17, 24, 39], colors = [[56, 189, 248], [251, 191, 36], [52, 211, 153]];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let c = bg;
      const shelf = y >= 138 && y < 146 && x >= 30 && x < 150;
      const book = Math.floor((x - 42) / 34);
      const inBook = x >= 42 && x < 144 && (x - 42) % 34 < 26 && y >= 44 + book * 8 && y < 138;
      if (shelf) c = [148, 163, 184];
      else if (inBook && book >= 0 && book < 3) c = colors[book];
      raw.set(c, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
