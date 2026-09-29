import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const FORMATS = { epub: 'application/epub+zip', pdf: 'application/pdf' };

// Book files live at storage/books/<slug>/<slug>.epub|pdf; covers at storage/covers/<slug>.jpg|png.
export class Files {
  constructor({ storageDir, contentDir }) {
    this.storageDir = storageDir;
    this.contentDir = contentDir;
  }

  bookPath(book, format) {
    if (!FORMATS[format]) return null;
    const p = join(this.storageDir, 'books', book.slug, `${book.slug}.${format}`);
    return existsSync(p) ? p : null;
  }

  coverPath(book) {
    for (const ext of ['jpg', 'jpeg', 'png']) {
      const p = join(this.storageDir, 'covers', `${book.slug}.${ext}`);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** Free chapter files: a book-specific sample folder if present, else the lead magnet. */
  samplePaths(book = null) {
    const dirs = [];
    if (book) dirs.push(join(this.contentDir, 'samples', book.slug));
    dirs.push(join(this.contentDir, 'samples', 'lead-magnet'));
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const manifest = join(dir, 'files.json');
      if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).map((f) => join(dir, f));
    }
    return [];
  }

  mtime(path) {
    return statSync(path).mtimeMs;
  }

  /** Returns the PDF with a licensing footer on every page (piracy deterrent); original bytes if stamping fails. */
  async stampedPdf(path, licenseLine, log = console) {
    const bytes = readFileSync(path);
    try {
      const pdf = await PDFDocument.load(bytes);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (const page of pdf.getPages()) {
        const { width } = page.getSize();
        const size = 7;
        const textWidth = font.widthOfTextAtSize(licenseLine, size);
        page.drawText(licenseLine, { x: (width - textWidth) / 2, y: 12, size, font, color: rgb(0.45, 0.45, 0.45) });
      }
      pdf.setSubject(licenseLine);
      return Buffer.from(await pdf.save());
    } catch (err) {
      log.error?.(`[files] PDF stamping failed for ${path}: ${err.message}`);
      return bytes;
    }
  }
}
