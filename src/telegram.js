import fs from 'node:fs';
import path from 'node:path';

export class TelegramError extends Error {
  constructor(method, body) {
    super(`Telegram ${method} failed: ${body.error_code} ${body.description}`);
    this.method = method;
    this.code = body.error_code;
    this.description = body.description;
    this.retryAfter = body.parameters?.retry_after;
  }
}

/**
 * Tiny Bot API client. `call(method, params)` sends JSON; params that are
 * `{ file: '/local/path', filename? }` are uploaded as multipart.
 */
export function createTelegramApi(token, { fetchImpl = fetch, maxRetries = 2 } = {}) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, params = {}) {
    for (let attempt = 0; ; attempt++) {
      const hasFile = Object.values(params).some((v) => v && typeof v === 'object' && 'file' in v);
      let init;
      if (hasFile) {
        const form = new FormData();
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined || v === null) continue;
          if (v && typeof v === 'object' && 'file' in v) {
            const blob = await fs.openAsBlob(v.file);
            form.append(k, blob, v.filename || path.basename(v.file));
          } else {
            form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
          }
        }
        init = { method: 'POST', body: form };
      } else {
        init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) };
      }
      const res = await fetchImpl(`${base}/${method}`, init);
      let body;
      try {
        body = await res.json();
      } catch {
        body = { ok: false, error_code: res.status, description: `non-JSON response (HTTP ${res.status})` };
      }
      if (body.ok) return body.result;
      const err = new TelegramError(method, body);
      const transient = err.retryAfter || res.status >= 500;
      if (transient && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, ((err.retryAfter ?? 1) + 0.5) * 1000));
        continue;
      }
      throw err;
    }
  }

  return { call };
}
