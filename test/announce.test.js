import test from 'node:test';
import assert from 'node:assert/strict';
import { channelPost, alertMessage } from '../src/announce.js';
import { makeCfg, makeDb } from './helpers.js';

test('drop announcements (channel post and alerts) are Stars-only, with no TON or web-checkout links', () => {
  const cfg = makeCfg();
  const db = makeDb();
  db.startLaunch('ai-control-center', 48);
  const book = db.getBook('ai-control-center');
  for (const m of [channelPost(book, cfg), alertMessage(book)]) {
    const all = JSON.stringify(m);
    assert.doesNotMatch(all, /\bTON\b|toncoin|tonkeeper|ton connect/i);
    assert.ok(!all.includes(cfg.publicUrl), 'no link to the web checkout');
    assert.match(m.text, /⭐ 300 Stars/);
  }
  const urls = channelPost(book, cfg).reply_markup.inline_keyboard.flat().map((b) => b.url);
  assert.ok(urls.every((u) => u.startsWith('https://t.me/YourShelfBot?start=')));
});
