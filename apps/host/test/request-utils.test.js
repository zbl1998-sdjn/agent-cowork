import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readJsonBody } from '../src/http/request-utils.js';

function requestFromText(text) {
  const request = Readable.from([Buffer.from(text, 'utf8')]);
  request.headers = { 'content-type': 'application/json' };
  return request;
}

test('readJsonBody enforces maxBytes by UTF-8 byte length', async () => {
  const payload = JSON.stringify({ text: '汉字汉字汉字汉字' });
  const maxBytes = payload.length + 1;
  assert.ok(Buffer.byteLength(payload, 'utf8') > maxBytes);

  await assert.rejects(
    readJsonBody(requestFromText(payload), { maxBytes }),
    /Request body too large/,
  );
});

test('readJsonBody parses JSON within byte limit', async () => {
  const payload = JSON.stringify({ text: 'ok' });
  const parsed = await readJsonBody(requestFromText(payload), {
    maxBytes: Buffer.byteLength(payload, 'utf8'),
  });
  assert.deepEqual(parsed, { text: 'ok' });
});
