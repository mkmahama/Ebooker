import { loadDotEnv, buildConfig, assertConfig } from './config.js';
import { openDb } from './db.js';
import { createTelegramApi } from './telegram.js';
import { createBot } from './bot/bot.js';
import { startPolling, setWebhook } from './bot/updates.js';
import { createWatcher } from './ton/watcher.js';
import { createWebServer } from './web/server.js';
import { formatTon } from './pricing.js';

loadDotEnv();
const cfg = buildConfig();
assertConfig(cfg);

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

const db = openDb(cfg.dbPath);
const api = createTelegramApi(cfg.botToken);
const bot = createBot({ db, api, cfg, log });

const watcher = createWatcher({
  db, cfg, log,
  onEvent: async (ev) => {
    const esc = (s) => String(s).replace(/</g, '&lt;');
    const lines = {
      paid: `💎 TON sale: <b>${ev.order?.book_id}</b> · ${formatTon(ev.value)} TON · order <code>${ev.order?.id}</code>`,
      underpaid: `⚠️ Underpaid TON order <code>${ev.order?.id}</code>: got ${formatTon(ev.value)}, expected ${ev.order && formatTon(ev.order.amount_nano)}. Refund or top-up manually.`,
      extra_payment: `⚠️ Extra transfer for already-settled order <code>${ev.order?.id}</code>: ${formatTon(ev.value)} TON, tx <code>${ev.hash}</code>.`,
      unknown_order: `⚠️ Transfer with unknown order comment <code>${esc(ev.comment)}</code>: ${formatTon(ev.value)} TON, tx <code>${ev.hash}</code>.`,
    };
    log.info(`watcher event ${ev.type}`, ev.order?.id || ev.comment || '');
    if (lines[ev.type]) await bot.notifySupport(lines[ev.type]);
  },
});

const server = createWebServer({ db, cfg, bot, log });
server.listen(cfg.port, () => log.info(`web: listening on :${cfg.port} (${cfg.publicUrl})`));

await bot.registerCommands().catch((e) => log.error(`setMyCommands: ${e.message}`));
const abort = new AbortController();
if (cfg.botMode === 'webhook') {
  // Keep serving TON checkout even if Telegram is briefly unreachable; retry until the webhook is set.
  const trySetWebhook = async () => {
    try {
      log.info(`bot: webhook set to ${await setWebhook({ api, cfg })}`);
    } catch (e) {
      log.error(`bot: setWebhook failed (${e.message}); retrying in 60s`);
      setTimeout(trySetWebhook, 60_000).unref();
    }
  };
  await trySetWebhook();
} else {
  startPolling({ api, bot, log, signal: abort.signal });
}
watcher.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`${sig}: shutting down`);
    abort.abort();
    watcher.stop();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
