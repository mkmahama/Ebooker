import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { seedCatalog } from './db/catalog.js';
import { Store } from './store.js';
import { TelegramApi } from './telegram/api.js';
import { Files } from './files/storage.js';
import { Bot } from './bot/bot.js';
import { TonPricer } from './pricing.js';
import { TonOrders } from './ton/orders.js';

/** Wires the shared services; used by the server entry point and the admin CLI. */
export function createApp({ config = loadConfig(), log = console, fetchImpl = globalThis.fetch } = {}) {
  const db = openDb(config.dbPath);
  seedCatalog(db);
  const store = new Store(db);
  const api = new TelegramApi({ token: config.bot.token, apiBase: config.bot.apiBase, fetchImpl });
  const files = new Files({ storageDir: config.storageDir, contentDir: config.contentDir });
  const bot = new Bot({ api, store, files, config, log });
  const pricer = new TonPricer(config.ton, { fetchImpl, log });
  const orders = new TonOrders({ store, pricer, config });
  return { config, db, store, api, files, bot, pricer, orders, log };
}
