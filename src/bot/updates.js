/**
 * Update delivery: long polling for development, webhook for production.
 * Webhook updates arrive via the web server (see web/server.js).
 */
const ALLOWED_UPDATES = ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member'];
const MAX_PAYMENT_ATTEMPTS = 5;

export async function startPolling({ api, bot, log = console, signal }) {
  await api.call('deleteWebhook', { drop_pending_updates: false });
  let offset = 0;
  const attempts = new Map();
  log.info?.('bot: long polling started');
  while (!signal?.aborted) {
    try {
      const updates = await api.call('getUpdates', { offset, timeout: 25, allowed_updates: ALLOWED_UPDATES });
      for (const u of updates) {
        if (u.pre_checkout_query) {
          await bot.handleUpdate(u); // answer before anything slower in the batch
        } else if (u.message?.successful_payment) {
          try {
            await bot.handleUpdate(u);
          } catch (e) {
            const n = (attempts.get(u.update_id) || 0) + 1;
            attempts.set(u.update_id, n);
            if (n < MAX_PAYMENT_ATTEMPTS) throw e; // leave offset here; this payment is fetched again
            log.error?.(`payment update ${u.update_id} failed ${n} times; giving up (check /paysupport)`);
          }
          attempts.delete(u.update_id);
        } else {
          bot.handleUpdate(u);
        }
        offset = u.update_id + 1;
      }
    } catch (e) {
      log.error?.(`polling error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export async function setWebhook({ api, cfg }) {
  const url = `${cfg.publicUrl}/tg/webhook`;
  await api.call('setWebhook', {
    url,
    secret_token: cfg.webhookSecret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });
  return url;
}
