import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramApi, TelegramError } from '../src/telegram.js';
import { fileURLToPath } from 'node:url';

test('Bot API client: JSON calls, errors, and non-JSON responses', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: init.body });
    if (url.endsWith('/getMe')) return { status: 200, json: async () => ({ ok: true, result: { id: 1 } }) };
    if (url.endsWith('/sendMessage')) return { status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) };
    return { status: 403, json: async () => { throw new SyntaxError('Unexpected token'); } };
  };
  const api = createTelegramApi('T0KEN', { fetchImpl, maxRetries: 0 });
  assert.deepEqual(await api.call('getMe'), { id: 1 });
  assert.equal(seen[0].url, 'https://api.telegram.org/botT0KEN/getMe');
  await assert.rejects(api.call('sendMessage', { chat_id: 1, text: 'x' }), (e) => e instanceof TelegramError && e.code === 400);
  await assert.rejects(api.call('setWebhook', {}), (e) => e instanceof TelegramError && /non-JSON response \(HTTP 403\)/.test(e.message));
});

test('Bot API client uploads local files as multipart', async () => {
  let form;
  const fetchImpl = async (_url, init) => { form = init.body; return { status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const api = createTelegramApi('T', { fetchImpl });
  await api.call('sendDocument', { chat_id: 5, document: { file: fileURLToPath(new URL('../package.json', import.meta.url)), filename: 'p.json' }, reply_markup: { a: 1 } });
  assert.ok(form instanceof FormData);
  assert.equal(form.get('chat_id'), '5');
  assert.equal(form.get('document').name, 'p.json');
  assert.equal(form.get('reply_markup'), '{"a":1}');
});
