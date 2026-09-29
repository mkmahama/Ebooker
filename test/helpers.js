import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { seedCatalog } from '../src/db/catalog.js';
import { Store } from '../src/store.js';
import { Files } from '../src/files/storage.js';
import { Bot } from '../src/bot/bot.js';
import { TonPricer } from '../src/pricing.js';
import { TonOrders } from '../src/ton/orders.js';

export const quietLog = { info() {}, warn() {}, error() {} };

/** Records every Bot API call and returns plausible results. */
export class FakeApi {
  constructor() {
    this.calls = [];
    this.nextMessageId = 1000;
    this.failures = {};
  }
  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (this.failures[method]) throw this.failures[method];
    const message_id = this.nextMessageId++;
    switch (method) {
      case 'sendDocument': return { message_id, document: { file_id: `file-${message_id}` } };
      case 'sendPhoto': return { message_id, photo: [{ file_id: `photo-${message_id}` }] };
      case 'createForumTopic': return { message_thread_id: 77, name: params.name };
      case 'copyMessage': return { message_id };
      default: return { message_id };
    }
  }
  of(method) { return this.calls.filter((c) => c.method === method); }
  texts(chatId) { return this.calls.filter((c) => c.method === 'sendMessage' && (chatId === undefined || c.params.chat_id === chatId)).map((c) => c.params.text); }
  reset() { this.calls = []; }
}

export async function makeStorage() {
  const root = mkdtempSync(join(tmpdir(), 'dropshelf-'));
  const storageDir = join(root, 'storage');
  const contentDir = join(root, 'content');
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]);
  const pdfBytes = await pdf.save();
  for (const slug of ['ai-control-center', 'automate-channel-ai', 'first-ai-workflow-weekend']) {
    mkdirSync(join(storageDir, 'books', slug), { recursive: true });
    writeFileSync(join(storageDir, 'books', slug, `${slug}.pdf`), pdfBytes);
    writeFileSync(join(storageDir, 'books', slug, `${slug}.epub`), Buffer.from(`PK epub ${slug}`));
  }
  mkdirSync(join(storageDir, 'covers'), { recursive: true });
  cpSync(new URL('../content/samples/lead-magnet', import.meta.url).pathname, join(contentDir, 'samples', 'lead-magnet'), { recursive: true });
  return { root, storageDir, contentDir };
}

export async function makeApp(overrides = {}) {
  const { storageDir, contentDir } = await makeStorage();
  const config = loadConfig({
    BOT_TOKEN: 'test', BOT_USERNAME: 'YourShelfBot', PUBLIC_URL: 'https://shop.example',
    SUPPORT_CHAT_ID: '-100500', DOWNLOAD_SECRET: 'secret', WEBHOOK_SECRET: 'hook',
    TON_WALLET_ADDRESS: 'UQShopWallet', TON_USD_RATE: '3', ...overrides,
  });
  config.storageDir = storageDir;
  config.contentDir = contentDir;
  const db = openDb(':memory:');
  seedCatalog(db);
  const store = new Store(db);
  const api = new FakeApi();
  const files = new Files({ storageDir, contentDir });
  const bot = new Bot({ api, store, files, config, log: quietLog });
  const pricer = new TonPricer(config.ton, { log: quietLog });
  const orders = new TonOrders({ store, pricer, config });
  return { config, db, store, api, files, bot, pricer, orders };
}

let updateId = 1;
export const user = (id, extra = {}) => ({ id, is_bot: false, first_name: `User${id}`, username: `user${id}`, ...extra });

export const textUpdate = (from, text) => ({
  update_id: updateId++,
  message: { message_id: updateId, from, chat: { id: from.id, type: 'private' }, date: 0, text },
});

export const callbackUpdate = (from, data) => ({
  update_id: updateId++,
  callback_query: { id: `cq${updateId}`, from, data, message: { message_id: 1, chat: { id: from.id, type: 'private' } } },
});

/** Runs the full Stars flow for a user and product: invoice -> pre_checkout -> successful_payment. */
export async function buyWithStars(app, from, slug, chargeId = `charge-${from.id}-${slug}`) {
  const book = app.store.getBookBySlug(slug);
  await app.bot.handleUpdate(callbackUpdate(from, `buy:${book.id}`));
  const inv = app.api.of('sendInvoice').at(-1).params;
  await app.bot.handleUpdate({ update_id: updateId++, pre_checkout_query: { id: `pcq${updateId}`, from, currency: 'XTR', total_amount: inv.prices[0].amount, invoice_payload: inv.payload } });
  const answer = app.api.of('answerPreCheckoutQuery').at(-1).params;
  if (!answer.ok) throw new Error(`pre-checkout rejected: ${answer.error_message}`);
  await app.bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: updateId, from, chat: { id: from.id, type: 'private' }, date: 0,
      successful_payment: { currency: 'XTR', total_amount: inv.prices[0].amount, invoice_payload: inv.payload, telegram_payment_charge_id: chargeId, provider_payment_charge_id: '' },
    },
  });
  return { invoice: inv, chargeId };
}
