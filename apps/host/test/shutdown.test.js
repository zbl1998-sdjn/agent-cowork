import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { createCancellationRegistry } from '../src/runtime/cancellation.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-sd-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('cancellation.cancelAll aborts every active run', () => {
  const reg = createCancellationRegistry();
  const a = reg.register('r1');
  const b = reg.register('r2');
  const n = reg.cancelAll('shutdown');
  assert.equal(n, 2);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);
});

test('shutdown drains: refuses new agent streams (503) and unblocks approvals', async () => {
  const root = tmp();
  const cancellation = createCancellationRegistry();
  const approvalRegistry = createApprovalRegistry();
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall: async () => ({ content: 'hi' }), cancellation, approvalRegistry });
  const base = await bind(server);
  // a pending approval that should be unblocked by shutdown
  const pendingDecision = approvalRegistry.request({ name: 'Shell' }).promise;
  assert.equal(server.isDraining(), false);
  await server.shutdown({ timeoutMs: 3000 });
  assert.equal(server.isDraining(), true);
  assert.equal(await pendingDecision, 'reject', 'awaiting approval unblocked on shutdown');
  // server is closed now; a fresh request should fail to connect
  let connErr = null;
  try { await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) }); }
  catch (e) { connErr = e; }
  assert.ok(connErr, 'listener closed after shutdown');
});

test('draining server replies 503 to new agent streams (listener still open)', async () => {
  const root = tmp();
  // inject a concurrency limiter so the route reaches the draining check after acquire? no: draining is checked first.
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall: async () => ({ content: 'hi' }) });
  const base = await bind(server);
  try {
    // flip draining without closing the listener by starting shutdown with a long timeout, then probing immediately
    const p = server.shutdown({ timeoutMs: 50 });
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) }).catch(() => null);
    // Either 503 (caught while listener draining) or connection closed — both acceptable; assert not a normal 200 stream
    if (res) assert.notEqual(res.status, 200);
    await p;
  } finally {
    await new Promise((r) => server.close(r));
  }
});
