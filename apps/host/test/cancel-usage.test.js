import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cu-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
const noop = { name: 'noop', risk: 'safe', mutating: false, description: 'noop', parameters: { type: 'object', properties: {} }, handler: async () => ({ ok: true }) };

test('runAgentChat accumulates token usage across model calls', async () => {
  const root = tmp();
  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'noop', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { content: '完成。', usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } };
  };
  const out = await runAgentChat({ prompt: 'x', kimiConfig: {}, trustedRoot: root, tools: [noop], modelCall, runStoreRoot: path.join(root, 'runs') });
  assert.equal(out.usage.prompt_tokens, 18);
  assert.equal(out.usage.completion_tokens, 7);
  assert.equal(out.usage.total_tokens, 25);
  assert.equal(out.cancelled, false);
});

test('runAgentChat stops between steps when the abort signal fires', async () => {
  const root = tmp();
  const ac = new AbortController();
  let calls = 0;
  const modelCall = async () => {
    calls += 1;
    ac.abort(); // user clicked stop during the first step
    return { content: '', tool_calls: [{ id: `c${calls}`, function: { name: 'noop', arguments: '{}' } }] };
  };
  const out = await runAgentChat({ prompt: 'x', kimiConfig: {}, trustedRoot: root, tools: [noop], modelCall, signal: ac.signal, maxSteps: 6, runStoreRoot: path.join(root, 'runs') });
  assert.equal(out.cancelled, true);
  assert.equal(calls, 1, 'stopped before the next model call');
});

test('E2E /api/agent/chat/stream: POST /api/runs/:id/cancel stops the run with a cancelled frame + usage in done', async () => {
  const root = tmp();
  let n = 0;
  const agentModelCall = async () => {
    n += 1;
    await new Promise((r) => setTimeout(r, 30));
    return { content: '', tool_calls: [{ id: `c${n}`, function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) } }] };
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'loop', autoApprove: true }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let runId = null;
    while (!runId) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /event: start\r?\ndata: (\{.*\})/.exec(all);
      if (m) runId = JSON.parse(m[1]).runId;
    }
    assert.ok(runId, 'start frame carried runId');
    const cx = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await cx.json()).cancelled, true);
    for (;;) { const { value, done } = await reader.read(); if (done) break; all += dec.decode(value, { stream: true }); }
    assert.match(all, /event: cancelled/);
  } finally {
    if (server.closeMcp) server.closeMcp();
    await new Promise((r) => server.close(r));
  }
});
