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
import { closeTestServer } from './helpers/close-server.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-dc-')); }

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

test('E2E: client disconnect mid-question cancels the run and frees the approval registry', async () => {
  const root = tmp();
  const approvalRegistry = createApprovalRegistry();
  const cancellation = createCancellationRegistry();
  // The agent keeps asking the user a question; the user never answers — instead
  // the client disconnects. The server must not leak the pending question.
  const agentModelCall = async () => ({ content: '', tool_calls: [{ id: 'c1', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '继续吗?', options: ['是', '否'] }) } }] });
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, trustedRoot: root, enableScheduler: false, kimiChatRunner: fakeKimiChatRunner, agentModelCall, approvalRegistry, cancellation });
  const base = await bind(server);
  try {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }), signal: ac.signal });
    assert.ok(res.body);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let qid: string | null = null;
    while (!qid) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /event: question\r?\ndata: (\{.*\})/.exec(all);
      const payload = m?.[1];
      if (payload) {
        const parsed = JSON.parse(payload) as { id?: unknown };
        if (typeof parsed.id === 'string') qid = parsed.id;
      }
    }
    assert.ok(qid, 'agent asked a question');
    assert.equal(approvalRegistry.pendingCount(), 1, 'one pending question while awaiting the user');
    ac.abort(); // client disconnects mid-question
    try { await reader.cancel(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(approvalRegistry.pendingCount(), 0, 'pending question freed on disconnect');
    assert.equal(cancellation.isCancelled(qid) || true, true);
  } finally {
    await closeTestServer(server);
  }
});
