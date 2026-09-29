// Renders the free chapter markdown into a simple PDF (headings, paragraphs, bullet and numbered lists).
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const [src = 'content/samples/lead-magnet/ai-daily-brief.md', out = 'content/samples/lead-magnet/ai-daily-brief.pdf'] = process.argv.slice(2);
const pdf = await PDFDocument.create();
const regular = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const W = 595, H = 842, M = 56, LINE = 1.45;
let page, y;
const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
newPage();

// Standard fonts only cover WinAnsi; map a few typographic characters.
const clean = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/–|—/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

function write(text, { font = regular, size = 11, indent = 0, color = rgb(0.1, 0.1, 0.12), gap = 6 } = {}) {
  const words = clean(text).split(/\s+/);
  const maxW = W - 2 * M - indent;
  let line = '';
  const flush = () => {
    if (y < M + size) newPage();
    page.drawText(line, { x: M + indent, y, size, font, color });
    y -= size * LINE;
    line = '';
  };
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > maxW && line) { flush(); line = w; } else line = next;
  }
  if (line) flush();
  y -= gap;
}

for (const raw of readFileSync(src, 'utf8').split('\n')) {
  const l = raw.trimEnd();
  if (!l) continue;
  if (l.startsWith('# ')) write(l.slice(2), { font: bold, size: 20, gap: 10 });
  else if (l.startsWith('## ')) { y -= 6; write(l.slice(3), { font: bold, size: 14, gap: 4 }); }
  else if (/^- /.test(l)) write(`•  ${l.slice(2)}`.replace('•', '-'), { indent: 12, gap: 2 });
  else if (/^\d+\. /.test(l)) write(l, { indent: 12, gap: 2 });
  else write(l);
}
pdf.setTitle('AI Daily Brief to Your Telegram');
pdf.setAuthor('Drop Shelf');
writeFileSync(out, await pdf.save());
console.log(`wrote ${out} (${pdf.getPageCount()} pages)`);
