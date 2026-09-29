import fs from 'node:fs';
import path from 'node:path';

/**
 * Content layout (replace the placeholders with your real files):
 *   content/sample/daily-brief-chapter.pdf     free lead-magnet chapter
 *   content/sample/daily-brief-workflow.json   importable n8n workflow
 *   content/books/<book-id>/book.epub
 *   content/books/<book-id>/book.pdf
 *   content/books/<book-id>/sample.pdf         optional per-book free chapter
 *   content/books/<book-id>/cover.jpg          optional cover shown in /shelf
 */
export const FORMATS = ['epub', 'pdf'];

export function bookFile(cfg, bookId, format) {
  if (!FORMATS.includes(format)) throw new Error(`bad format ${format}`);
  if (!/^[a-z0-9-]+$/.test(bookId)) throw new Error(`bad book id ${bookId}`);
  return path.join(cfg.contentDir, 'books', bookId, `book.${format}`);
}

export function coverFile(cfg, bookId) {
  const p = path.join(cfg.contentDir, 'books', bookId, 'cover.jpg');
  return fs.existsSync(p) ? p : null;
}

export function bookSampleFile(cfg, bookId) {
  const p = path.join(cfg.contentDir, 'books', bookId, 'sample.pdf');
  return fs.existsSync(p) ? p : null;
}

export function leadMagnetFiles(cfg) {
  return [
    path.join(cfg.contentDir, 'sample', 'daily-brief-chapter.pdf'),
    path.join(cfg.contentDir, 'sample', 'daily-brief-workflow.json'),
  ].filter((p) => fs.existsSync(p));
}

export function downloadName(book, format) {
  const slug = book.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug}.${format}`;
}

export const MIME = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  json: 'application/json',
  jpg: 'image/jpeg',
};
