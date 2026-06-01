import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { KimiTextResult } from '../src/kimi/api-runner.js';
import type { KimiStreamOptions, KimiStreamResult } from '../src/kimi/api-runner-stream.js';
import { CancellationRegistry } from '../src/runtime/cancellation.js';
import { createServer } from '../src/server.js';
import type { HostServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';

type JsonRecord = Record<string, unknown>;

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cancel-')); }

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

async function fakeKimiChatRunner(): Promise<KimiTextResult> {
  return { ok: true, provider: 'test', model: 'test', mode: 'chat', text: 'x', durationMs: 0 };
}

test('CancellationRegistry register/signal/cancel/done semantics', () => {
  const reg = new CancellationRegistry();
  const ctrl = reg.register('run_1');
  assert.equal(reg.signal('run_1'), ctrl.signal);
  assert.equal(reg.isCancelled('run_1'), false);
  assert.equal(reg.cancel('run_1'), true);
  assert.equal(reg.isCancelled('run_1'), true);
  assert.equal(reg.cancel('ghost'), false);
  assert.deepEqual(reg.pending(), ['run_1']);
  assert.equal(reg.done('run_1'), true);
  assert.deepEqual(reg.pending(), []);
});

test('POST /api/runs/:id/cancel returns cancelled:false for an unknown run', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/runs/run_nope/cancel`, { method: 'POST' });
    const body = requireJsonRecord(await res.json(), 'cancel response');
    assert.equal(res.status, 200);
    assert.equal(body.cancelled, false);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/runs/:id/cancel rejects encoded path escapes in run id', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/runs/run_bad%2Fescape/cancel`, { method: 'POST' });
    const body = requireJsonRecord(await res.json(), 'cancel response');
    assert.equal(res.status, 400);
    if (typeof body.error !== 'string') {
      throw new TypeError('cancel response.error must be a string');
    }
    assert.match(body.error, /runId|run id/i);
  } finally {
    await closeTestServer(server);
  }
});

test('streaming chat can be cancelled mid-flight via /api/runs/:id/cancel', async () => {
  const fakeStream = async ({ onToken, signal }: KimiStreamOptions = {}): Promise<KimiStreamResult> => {
    onToken?.('部分');
    for (let i = 0; i < 200; i += 1) {
      if (signal && signal.aborted) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    return { ok: true, provider: 'test', model: 'fake', mode: 'chat', text: '部分', durationMs: 0 };
  };
  const server = createServer({
    trustedRoot: tmp(), enableScheduler: false,
    kimiChatRunner: fakeKimiChatRunner,
    kimiChatStreamRunner: fakeStream,
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }),
    });
    assert.ok(res.body);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let runId: string | null = null;
    while (!runId) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /"runId":"(run_[^"]+)"/.exec(all);
      if (m?.[1]) runId = m[1];
    }
    assert.ok(runId, 'got runId from start frame');
    const c = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
    assert.equal(requireJsonRecord(await c.json(), 'cancel response').cancelled, true);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
    }
    assert.match(all, /event: token/);
    assert.match(all, /event: cancelled/);
  } finally {
    await closeTestServer(server);
  }
});
