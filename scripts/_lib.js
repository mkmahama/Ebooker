import { loadDotEnv, buildConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createTelegramApi } from '../src/telegram.js';

export function boot({ needBot = true } = {}) {
  loadDotEnv();
  const cfg = buildConfig();
  if (needBot && !cfg.botToken) throw new Error('BOT_TOKEN is not set (.env)');
  const db = openDb(cfg.dbPath);
  const api = cfg.botToken ? createTelegramApi(cfg.botToken) : null;
  return { cfg, db, api };
}

export function flag(args, name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
