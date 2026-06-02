import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonBody } from '../src/http/request-utils.js';
import { ManualHttpRequest } from './helpers/manual-http-request.js';

async function readTextBody(text: string, maxBytes: number): Promise<unknown> {
  const request = new ManualHttpRequest();
  const body = readJsonBody(request, { maxBytes });
  request.emit('data', Buffer.from(text, 'utf8'));
  request.emit('end');
  return body;
}

test('readJsonBody enforces maxBytes by UTF-8 byte length', async () => {
  const payload = JSON.stringify({ text: '汉字汉字汉字汉字' });
  const maxBytes = payload.length + 1;
  assert.ok(Buffer.byteLength(payload, 'utf8') > maxBytes);

  await assert.rejects(
    () => readTextBody(payload, maxBytes),
    /Request body too large/,
  );
});

test('readJsonBody parses JSON within byte limit', async () => {
  const payload = JSON.stringify({ text: 'ok' });
  const parsed = await readTextBody(payload, Buffer.byteLength(payload, 'utf8'));
  assert.deepEqual(parsed, { text: 'ok' });
});
