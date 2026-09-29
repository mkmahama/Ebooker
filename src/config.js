import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader (no dependencies). Existing process.env values win. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

/** Build a config object from an env map. Tests pass their own map. */
export function buildConfig(env = process.env) {
  return {
    botToken: env.BOT_TOKEN || '',
    botUsername: (env.BOT_USERNAME || 'YourShelfBot').replace(/^@/, ''),
    botMode: env.BOT_MODE || 'polling',
    webhookSecret: env.WEBHOOK_SECRET || '',
    supportChatId: env.SUPPORT_CHAT_ID || '',
    supportUsername: (env.SUPPORT_USERNAME || '').replace(/^@/, ''),
    channelId: env.CHANNEL_ID || '',

    port: num(env.PORT, 8080),
    publicUrl: (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),
    linkSecret: env.LINK_SECRET || '',
    linkTtlMinutes: num(env.LINK_TTL_MINUTES, 60),
    tonReceiver: env.TON_RECEIVER_ADDRESS || '',
    tonNetwork: env.TON_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
    toncenterApiKey: env.TONCENTER_API_KEY || '',
    tonPerStar: num(env.TON_PER_STAR, 0.005),
    tonDiscount: num(env.TON_DISCOUNT, 0.12),
    orderTtlMinutes: num(env.ORDER_TTL_MINUTES, 30),
    watchIntervalSeconds: num(env.WATCH_INTERVAL_SECONDS, 10),

    referralGoal: num(env.REFERRAL_GOAL, 3),
    referralRewardBookId: env.REFERRAL_REWARD_BOOK_ID || 'first-ai-workflow',

    dbPath: env.DB_PATH || './data/dropshelf.db',
    contentDir: path.resolve(env.CONTENT_DIR || './content'),
  };
}

/** Fail fast on settings the running services cannot work without. */
export function assertConfig(cfg, { bot = true, ton = true } = {}) {
  const missing = [];
  if (bot && !cfg.botToken) missing.push('BOT_TOKEN');
  if (bot && cfg.botMode === 'webhook' && !cfg.webhookSecret) missing.push('WEBHOOK_SECRET');
  if (!cfg.linkSecret || cfg.linkSecret.length < 32) missing.push('LINK_SECRET (32+ chars)');
  if (ton && !cfg.tonReceiver) missing.push('TON_RECEIVER_ADDRESS');
  if (missing.length) throw new Error(`Missing or invalid settings: ${missing.join(', ')}`);
}
