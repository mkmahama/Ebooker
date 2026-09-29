import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader so the app runs without extra dependencies.
function loadDotEnv(path = resolve(process.cwd(), '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function loadConfig(env = process.env) {
  if (env === process.env) loadDotEnv();
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
  const publicUrl = (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  return {
    port: num('PORT', 3000),
    publicUrl,
    dbPath: env.DB_PATH || resolve('data/dropshelf.db'),
    storageDir: resolve(env.STORAGE_DIR || 'storage'),
    contentDir: resolve(env.CONTENT_DIR || 'content'),

    bot: {
      token: env.BOT_TOKEN || '',
      username: (env.BOT_USERNAME || 'YourShelfBot').replace(/^@/, ''),
      mode: env.BOT_MODE || 'webhook', // webhook | polling | off
      webhookSecret: env.WEBHOOK_SECRET || '',
      apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    },
    channel: {
      id: env.CHANNEL_ID || '', // e.g. @YourShelf or -100123...
    },
    support: {
      chatId: env.SUPPORT_CHAT_ID || '', // admin group (ideally a forum supergroup)
      useTopics: env.SUPPORT_USE_TOPICS === 'true',
      contactUrl: env.SUPPORT_CONTACT_URL || '',
    },
    referral: {
      target: num('REFERRAL_TARGET', 3),
      rewardSlug: env.REFERRAL_REWARD_SLUG || 'first-ai-workflow-weekend',
    },
    pricing: {
      launchHours: num('LAUNCH_HOURS', 48),
      invoiceTtlHours: num('INVOICE_TTL_HOURS', 24),
    },
    ton: {
      wallet: env.TON_WALLET_ADDRESS || '',
      network: env.TON_NETWORK || 'mainnet', // mainnet | testnet
      apiBase: env.TONCENTER_API || 'https://toncenter.com/api/v2',
      apiKey: env.TONCENTER_API_KEY || '',
      pollSeconds: num('TON_POLL_SECONDS', 10),
      orderTtlMinutes: num('TON_ORDER_TTL_MINUTES', 60),
      // TON price = Stars price * STAR_USD * (1 - discount) / TON_USD
      pricingMode: env.TON_PRICING_MODE || 'fixed', // fixed | usd_peg
      starUsd: num('STAR_USD', 0.013),
      discount: num('TON_DISCOUNT', 0.12),
      tonUsd: num('TON_USD_RATE', 3.0), // fixed rate, and fallback for usd_peg
      rateUrl: env.TON_RATE_URL || 'https://tonapi.io/v2/rates?tokens=ton&currencies=usd',
      rateRefreshHours: num('TON_RATE_REFRESH_HOURS', 6),
    },
    downloads: {
      secret: env.DOWNLOAD_SECRET || '',
      ttlHours: num('DOWNLOAD_TTL_HOURS', 24),
    },
    adminIds: (env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  };
}
