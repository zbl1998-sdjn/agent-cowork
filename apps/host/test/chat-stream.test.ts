import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import type { HostServer, ServerConfig } from '../src/server.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-stream-'));
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

test('POST /api/kimi/chat/stream emits start/token/done SSE frames and records a run', async () => {
  const fakeStream: NonNullable<ServerConfig['kimiChatStreamRunner']> = async ({ prompt, onToken } = {}) => {
    assert.match(String(prompt), /你好/);
    if (typeof onToken !== 'function') {
      throw new Error('stream test requires onToken callback');
    }
    for (const t of ['你', '好', '世界']) onToken(t);
    return { ok: true, provider: 'kimi-api', model: 'fake-model', mode: 'chat', text: '你好世界', durationMs: 0 };
  };
  const server = createServer({
    trustedRoot: tempRoot(),
    enableScheduler: false,
    kimiChatRunner: async () => ({ ok: true, provider: 'kimi-api', model: 'fake-model', mode: 'chat', text: 'x', durationMs: 0 }), // flips kimiApiEnabled on
    kimiChatStreamRunner: fakeStream,
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '你好', model: 'fake-model' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: token/);
    assert.equal((text.match(/event: token/g) || []).length, 3, 'one token frame per delta');
    assert.match(text, /event: done/);
    assert.match(text, /你好世界/);

    const indexBody = recordValue(await (await fetch(`${base}/api/runs/index`)).json(), 'runs index body');
    const runs = recordArray(indexBody.runs, 'runs index records');
    assert.ok(runs.some((run) => run.type === 'kimi-chat'));
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/kimi/chat/stream returns 503 when Kimi API is not configured', async () => {
  const server = createServer({ trustedRoot: tempRoot(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }),
    });
    assert.equal(res.status, 503);
    const body = recordValue(await res.json(), 'error response body');
    assert.match(String(body.error), /需要模型回复时请联网/);
  } finally {
    await closeTestServer(server);
  }
});
