import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonBody, withJsonBody } from '../src/http/request-utils.js';
import { ManualHttpRequest } from './helpers/manual-http-request.js';
import type { HttpResponseLike } from '../src/http/request-utils.js';

type CapturedResponse = HttpResponseLike & { status: number; body: string; json(): Record<string, unknown> };

async function readTextBody(text: string, maxBytes: number): Promise<unknown> {
  const request = new ManualHttpRequest();
  const body = readJsonBody(request, { maxBytes });
  request.emit('data', Buffer.from(text, 'utf8'));
  request.emit('end');
  return body;
}

function capturedResponse(): CapturedResponse {
  return {
    status: 0,
    body: '',
    writeHead(statusCode) {
      this.status = statusCode;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    json() {
      const parsed = JSON.parse(this.body || '{}') as unknown;
      assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'response body should be a JSON object');
      return parsed as Record<string, unknown>;
    },
  };
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

test('withJsonBody rejects non-JSON content types before reading the body', async () => {
  const request = new ManualHttpRequest({ 'content-type': 'text/plain' });
  const response = capturedResponse();

  await withJsonBody(request, response, () => {
    throw new Error('handler should not run');
  });

  assert.equal(response.status, 415);
  assert.match(String(response.json().error), /application\/json/);
});

test('withJsonBody maps invalid JSON and handler HTTP errors to structured JSON responses', async () => {
  let request = new ManualHttpRequest();
  let response = capturedResponse();
  const invalid = withJsonBody(request, response, () => {
    throw new Error('handler should not run after invalid JSON');
  });
  request.emit('data', '{"broken"');
  request.emit('end');
  await invalid;

  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /Invalid JSON body/);

  request = new ManualHttpRequest();
  response = capturedResponse();
  const routed = withJsonBody(request, response, () => {
    const error = new Error('route rejected') as Error & { statusCode?: number; payload?: Record<string, unknown> };
    error.statusCode = 422;
    error.payload = { code: 'bad_route' };
    throw error;
  });
  request.emit('data', JSON.stringify({ ok: true }));
  request.emit('end');
  await routed;

  assert.equal(response.status, 422);
  assert.deepEqual(response.json(), { error: 'route rejected', code: 'bad_route' });
});
