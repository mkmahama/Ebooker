import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export class TelegramError extends Error {
  constructor(method, body) {
    super(`${method}: ${body.description || 'request failed'}`);
    this.code = body.error_code;
    this.retryAfter = body.parameters?.retry_after;
  }
}

/** A thin Bot API client. Files are sent as { path } or { buffer, filename } and uploaded as multipart. */
export class TelegramApi {
  constructor({ token, apiBase = 'https://api.telegram.org', fetchImpl = globalThis.fetch }) {
    this.base = `${apiBase}/bot${token}`;
    this.fetch = fetchImpl;
  }

  async call(method, params = {}) {
    const fileEntries = Object.entries(params).filter(([, v]) => v && typeof v === 'object' && (v.path || v.buffer));
    let init;
    if (fileEntries.length) {
      const form = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (v && typeof v === 'object' && (v.path || v.buffer)) {
          const data = v.buffer || readFileSync(v.path);
          form.append(k, new Blob([data], { type: v.contentType || 'application/octet-stream' }), v.filename || basename(v.path));
        } else {
          form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
      }
      init = { method: 'POST', body: form };
    } else {
      init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) };
    }
    const res = await this.fetch(`${this.base}/${method}`, init);
    const body = await res.json();
    if (!body.ok) throw new TelegramError(method, body);
    return body.result;
  }
}
