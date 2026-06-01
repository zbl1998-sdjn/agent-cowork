import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { KimiTextResult } from '../src/kimi/api-runner.js';
import { createServer } from '../src/server.js';
import type { HostServer } from '../src/server.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { createCancellationRegistry } from '../src/runtime/cancellation.js';
import { createConcurrencyLimiter } from '../src/runtime/concurrency.js';
import { closeTestServer } from './helpers/close-server.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-soak-')); }

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function fakeKimiChatRunner(): Promise<KimiTextResult> {
  return { ok: true, provider: 'test', model: 'test', mode: 'chat', text: 'ok', durationMs: 0 };
}

// Leak/soak proof of the multi-user hardening: many concurrent agent streams all
// park awaiting a user question, then the clients disconnect en masse. The
// registries (pending approvals + active runs) MUST drain back to zero — this is
// the property that lets a host instance survive 100k churny SSE connections
// without unbounded memory growth.
test('N concurrent awaiting streams all disconnect -> registries drain to zero (no leak)', async () => {
  const root = tmp();
  const approvalRegistry = createApprovalRegistry();
  const cancellation = createCancellationRegistry();
  const agentConcurrency = createConcurrencyLimiter({ maxConcurrent: 1000, maxPerTenant: 1000 });
  // Every run immediately asks a question and then awaits the user.
  const agentModelCall = async () => ({ content: '', tool_calls: [{ id: 'q', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '继续?', options: ['a', 'b'] }) } }] });
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: fakeKimiChatRunner, agentModelCall, approvalRegistry, cancellation, agentConcurrency });
  const base = await bind(server);
  const N = 40;
  const controllers: AbortController[] = [];
  try {
    const waits: Array<Promise<void>> = [];
    for (let i = 0; i < N; i += 1) {
      const ac = new AbortController();
      controllers.push(ac);
      waits.push((async () => {
        try {
          const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: `soak-${i}` }), signal: ac.signal });
          assert.ok(res.body);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            if (/event: question/.test(buf)) break; // parked awaiting the user
          }
        } catch { /* aborted is expected for the disconnect phase */ }
      })());
    }
    await Promise.all(waits);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(approvalRegistry.pendingCount() >= N * 0.5, `many streams parked awaiting (${approvalRegistry.pendingCount()})`);

    // Mass client disconnect.
    for (const ac of controllers) ac.abort();
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(approvalRegistry.pendingCount(), 0, 'no leaked pending approvals after mass disconnect');
    assert.equal(cancellation.pending().length, 0, 'no leaked active runs after mass disconnect');
    assert.equal(agentConcurrency.stats().active, 0, 'all concurrency slots released');
  } finally {
    await closeTestServer(server);
  }
});
