import { createApp } from './app.js';
import { createWebServer } from './web/server.js';
import { TonWatcher } from './ton/watcher.js';
import { COMMANDS } from './bot/bot.js';

const app = createApp();
const { config, store, api, bot, pricer, orders, files, log } = app;

for (const [key, ok] of [['BOT_TOKEN', config.bot.token], ['DOWNLOAD_SECRET', config.downloads.secret]]) {
  if (!ok) { log.error(`${key} is required`); process.exit(1); }
}
if (config.bot.mode === 'webhook' && !config.bot.webhookSecret) {
  log.error('WEBHOOK_SECRET is required in webhook mode'); process.exit(1);
}

const server = createWebServer({ config, store, pricer, orders, files, log, onTelegramUpdate: (u) => bot.handleUpdate(u) });
server.listen(config.port, () => log.info(`[web] listening on :${config.port} (${config.publicUrl})`));

const allowed_updates = ['message', 'callback_query', 'pre_checkout_query'];
await api.call('setMyCommands', { commands: COMMANDS }).catch((err) => log.warn(`[bot] setMyCommands: ${err.message}`));

if (config.bot.mode === 'webhook') {
  await api.call('setWebhook', {
    url: `${config.publicUrl}/telegram/webhook`,
    secret_token: config.bot.webhookSecret,
    allowed_updates,
  }).then(() => log.info('[bot] webhook set'), (err) => log.error(`[bot] setWebhook failed: ${err.message}`));
} else if (config.bot.mode === 'polling') {
  await api.call('deleteWebhook', {}).catch(() => {});
  (async function poll(offset = 0) {
    for (;;) {
      try {
        const updates = await api.call('getUpdates', { offset, timeout: 30, allowed_updates });
        for (const u of updates) {
          offset = u.update_id + 1;
          await bot.handleUpdate(u);
        }
      } catch (err) {
        log.error(`[bot] polling: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  log.info('[bot] long polling started');
}

await pricer.refreshRate();
setInterval(() => pricer.refreshRate(), config.ton.rateRefreshHours * 3600_000).unref();

const watcher = new TonWatcher({ store, config, log });
watcher.start();

const shutdown = () => { watcher.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
