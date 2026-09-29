/**
 * Creates placeholder content so the bot and web checkout work end to end before
 * the real books exist. Never overwrites existing files unless --force is passed.
 *   npm run placeholders [-- --force]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, buildConfig } from '../src/config.js';
import { SEED_BOOKS } from '../src/db.js';

loadDotEnv();
const cfg = buildConfig();
const force = process.argv.includes('--force');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let written = 0;

function write(file, data) {
  if (fs.existsSync(file) && !force) { console.log(`skip (exists) ${path.relative(root, file)}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  written++;
  console.log(`wrote ${path.relative(root, file)}`);
}

// ---------- minimal one-page PDF ----------
export function makePdf(title, lines) {
  const escPdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, '-');
  let y = 760;
  const ops = [`BT /F2 20 Tf 60 ${y} Td (${escPdf(title)}) Tj ET`];
  y -= 36;
  for (const line of lines) { ops.push(`BT /F1 12 Tf 60 ${y} Td (${escPdf(line)}) Tj ET`); y -= 18; }
  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- minimal EPUB 3 (stored zip, mimetype first) ----------
function zipStored(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name); const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function makeEpub(id, title, paragraphs) {
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = paragraphs.map((p) => `<p>${x(p)}</p>`).join('\n');
  const files = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">dropshelf-${id}</dc:identifier><dc:title>${x(title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`],
    ['OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${x(title)}</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">${x(title)}</a></li></ol></nav></body></html>`],
    ['OEBPS/chapter.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${x(title)}</title></head><body><h1>${x(title)}</h1>\n${body}</body></html>`],
  ];
  return zipStored(files.map(([name, s]) => ({ name, data: Buffer.from(s, 'utf8') })));
}

// ---------- 180x180 PNG icon ----------
function makeIcon() {
  const size = 180;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let yy = 0; yy < size; yy++) {
    raw[yy * (size * 4 + 1)] = 0;
    for (let xx = 0; xx < size; xx++) {
      const i = yy * (size * 4 + 1) + 1 + xx * 4;
      const shelf = xx > 40 && xx < 140 && [60, 90, 120].some((s) => yy >= s && yy < s + 10);
      const r = Math.hypot(Math.max(0, Math.abs(xx - 89.5) - 60), Math.max(0, Math.abs(yy - 89.5) - 60));
      const inside = r < 30;
      const [cr, cg, cb] = shelf ? [247, 246, 242] : [23, 24, 28];
      raw[i] = cr; raw[i + 1] = cg; raw[i + 2] = cb; raw[i + 3] = inside ? 255 : 0;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- starter n8n workflow for the lead magnet ----------
const dailyBrief = {
  name: 'AI Daily Brief to Telegram (Drop Shelf starter)',
  nodes: [
    { parameters: { content: '## AI daily brief\nEvery morning: read your feeds, summarize with AI, send to Telegram.\n\n1. Set your feed URL in **Read feed**.\n2. Add OpenAI credentials to **Chat model**.\n3. Add Telegram credentials and your chat id to **Send brief**.\n\nStarter file from Drop Shelf. Test it before relying on it.', height: 300, width: 360 }, id: 'b1d1a0e0-0000-4000-8000-000000000001', name: 'Read me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-420, -120] },
    { parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 7, triggerAtMinute: 30 }] } }, id: 'b1d1a0e0-0000-4000-8000-000000000002', name: 'Every morning', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0] },
    { parameters: { url: 'https://hnrss.org/frontpage', options: {} }, id: 'b1d1a0e0-0000-4000-8000-000000000003', name: 'Read feed', type: 'n8n-nodes-base.rssFeedRead', typeVersion: 1.1, position: [220, 0] },
    { parameters: { maxItems: 10 }, id: 'b1d1a0e0-0000-4000-8000-000000000004', name: 'Top 10', type: 'n8n-nodes-base.limit', typeVersion: 1, position: [440, 0] },
    { parameters: { aggregate: 'aggregateAllItemData', options: {} }, id: 'b1d1a0e0-0000-4000-8000-000000000005', name: 'Combine items', type: 'n8n-nodes-base.aggregate', typeVersion: 1, position: [660, 0] },
    { parameters: { promptType: 'define', text: "=Write a short morning brief (max 8 bullets, one line each, plain text) from these headlines. Group related items and say why each matters.\n\n{{ $json.data.map(i => '- ' + i.title + ' (' + i.link + ')').join('\\n') }}" }, id: 'b1d1a0e0-0000-4000-8000-000000000006', name: 'Summarize', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4, position: [880, 0] },
    { parameters: { model: 'gpt-4o-mini', options: {} }, id: 'b1d1a0e0-0000-4000-8000-000000000007', name: 'Chat model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1, position: [880, 200] },
    { parameters: { chatId: 'YOUR_TELEGRAM_CHAT_ID', text: '={{ "☀️ Your brief\\n\\n" + $json.text }}', additionalFields: { appendAttribution: false } }, id: 'b1d1a0e0-0000-4000-8000-000000000008', name: 'Send brief', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [1120, 0] },
  ],
  connections: {
    'Every morning': { main: [[{ node: 'Read feed', type: 'main', index: 0 }]] },
    'Read feed': { main: [[{ node: 'Top 10', type: 'main', index: 0 }]] },
    'Top 10': { main: [[{ node: 'Combine items', type: 'main', index: 0 }]] },
    'Combine items': { main: [[{ node: 'Summarize', type: 'main', index: 0 }]] },
    'Chat model': { ai_languageModel: [[{ node: 'Summarize', type: 'ai_languageModel', index: 0 }]] },
    Summarize: { main: [[{ node: 'Send brief', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
};

const PLACEHOLDER = ['PLACEHOLDER EDITION', 'Replace this file with the real book before launch:', 'content/books/<book-id>/book.pdf and book.epub', '', 'Generated by npm run placeholders.'];

for (const b of SEED_BOOKS) {
  const dir = path.join(cfg.contentDir, 'books', b.id);
  write(path.join(dir, 'book.pdf'), makePdf(b.title, [b.pitch, '', ...PLACEHOLDER]));
  write(path.join(dir, 'book.epub'), makeEpub(b.id, b.title, [b.pitch, ...PLACEHOLDER.filter(Boolean)]));
}
write(path.join(cfg.contentDir, 'sample', 'daily-brief-chapter.pdf'), makePdf('Free chapter: AI daily brief to your Telegram', [
  'What you build: every morning, n8n reads your feeds, an AI model',
  'summarizes them, and the brief lands in your Telegram chat.',
  '',
  '1. Import daily-brief-workflow.json into n8n (Workflows > Import from file).',
  '2. Set your feed URL in "Read feed".',
  '3. Add OpenAI credentials to "Chat model".',
  '4. Create a bot with @BotFather, add its token as Telegram credentials,',
  '   and put your chat id in "Send brief".',
  '5. Run it once with "Test workflow", then activate it.',
  '',
  'PLACEHOLDER: replace with the finished, tested chapter before launch.',
]));
write(path.join(cfg.contentDir, 'sample', 'daily-brief-workflow.json'), Buffer.from(`${JSON.stringify(dailyBrief, null, 2)}\n`));
write(path.join(root, 'public', 'icon.png'), makeIcon());
console.log(`\n${written} file(s) written.`);
