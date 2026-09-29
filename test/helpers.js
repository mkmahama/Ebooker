import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let contentDir;

/** Placeholder content generated once into a temp dir. */
export function testContentDir() {
  if (contentDir) return contentDir;
  contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropshelf-content-'));
  execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', 'scripts/make-placeholders.js', '--force'], {
    cwd: ROOT, env: { ...process.env, CONTENT_DIR: contentDir }, stdio: 'ignore',
  });
  return contentDir;
}

export function makeCfg(over = {}) {
  return {
    ...buildConfig({
      BOT_TOKEN: 'test', BOT_USERNAME: 'YourShelfBot', WEBHOOK_SECRET: 'whsecret-123',
      SUPPORT_CHAT_ID: '-100999', SUPPORT_USERNAME: 'ShelfSupport', CHANNEL_ID: '@YourShelf',
      PUBLIC_URL: 'https://shop.test', LINK_SECRET: 'x'.repeat(40), TON_RECEIVER_ADDRESS: 'UQTESTRECEIVER',
      TON_PER_STAR: '0.005', TON_DISCOUNT: '0.12', REFERRAL_GOAL: '3', REFERRAL_REWARD_BOOK_ID: 'first-ai-workflow',
      CONTENT_DIR: testContentDir(),
    }),
    ...over,
  };
}

export function makeDb() {
  return openDb(':memory:');
}

/** Fake Bot API that records every call. */
export function fakeApi({ fail = {} } = {}) {
  let n = 100;
  const calls = [];
  const api = {
    calls,
    async call(method, params = {}) {
      calls.push({ method, params });
      if (fail[method]) throw fail[method];
      switch (method) {
        case 'sendMessage':
        case 'copyMessage':
        case 'sendPhoto':
        case 'sendInvoice':
          return { message_id: ++n };
        case 'sendDocument': {
          const id = ++n;
          return { message_id: id, document: { file_id: `FILE_${id}` } };
        }
        default:
          return true;
      }
    },
    of: (method) => calls.filter((c) => c.method === method),
    clear: () => { calls.length = 0; },
    texts: () => calls.flatMap((c) => [c.params.text, c.params.caption].filter(Boolean)),
  };
  return api;
}

export const silentLog = { info() {}, warn() {}, error() {} };

let upd = 1;
export function msgUpdate(from, text, extra = {}) {
  return { update_id: upd++, message: { message_id: upd, from, chat: { id: from.id, type: 'private' }, date: 0, text, ...extra } };
}
export function cbUpdate(from, data) {
  return { update_id: upd++, callback_query: { id: `cb${upd}`, from, data, message: { message_id: 1, chat: { id: from.id, type: 'private' } } } };
}
export function preCheckoutUpdate(from, { payload, amount, currency = 'XTR' }) {
  return { update_id: upd++, pre_checkout_query: { id: `pcq${upd}`, from, currency, total_amount: amount, invoice_payload: payload } };
}
export function paidUpdate(from, { payload, amount, charge }) {
  return msgUpdate(from, undefined, {
    successful_payment: { currency: 'XTR', total_amount: amount, invoice_payload: payload, telegram_payment_charge_id: charge, provider_payment_charge_id: '' },
  });
}
