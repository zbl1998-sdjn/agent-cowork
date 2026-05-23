import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CancellationRegistry } from '../src/runtime/cancellation.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cancel-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

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
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.cancelled, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('streaming chat can be cancelled mid-flight via /api/runs/:id/cancel', async () => {
  const fakeStream = async ({ onToken, signal }) => {
    onToken('部分');
    for (let i = 0; i < 200; i += 1) {
      if (signal && signal.aborted) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    return { text: '部分', model: 'fake' };
  };
  const server = createServer({
    trustedRoot: tmp(), enableScheduler: false,
    kimiChatRunner: async () => ({ ok: true, text: 'x' }),
    kimiChatStreamRunner: fakeStream,
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let runId = null;
    while (!runId) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /"runId":"(run_[^"]+)"/.exec(all);
      if (m) runId = m[1];
    }
    assert.ok(runId, 'got runId from start frame');
    const c = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
    assert.equal((await c.json()).cancelled, true);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
    }
    assert.match(all, /event: token/);
    assert.match(all, /event: cancelled/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
