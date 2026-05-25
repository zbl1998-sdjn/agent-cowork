import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-apr-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

// A run that calls one tool (by name), then answers.
function callThenAnswer(toolName, args = {}) {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: toolName, arguments: JSON.stringify(args) } }] };
    return { content: '完成。' };
  };
}
function tool(name, risk, onRun) {
  return { name, risk, description: name, parameters: { type: 'object', properties: {} }, handler: async () => { onRun(); return { ok: true }; } };
}
function mutatingTool(name, risk, onRun) {
  return { name, risk, mutating: true, description: name, parameters: { type: 'object', properties: {} }, handler: async () => { onRun(); return { ok: true }; } };
}

test('approval registry resolves a pending request with a decision', async () => {
  const reg = createApprovalRegistry();
  const { id, promise } = reg.request({ name: 'Shell' });
  assert.match(id, /^apr_/);
  assert.equal(reg.resolve(id, 'once'), true);
  assert.equal(await promise, 'once');
  assert.equal(reg.resolve('ghost', 'once'), false);
});

test('approval registry resolveMany resolves only exact IDs and preserves scope', async () => {
  const reg = createApprovalRegistry();
  const a = reg.request({ name: 'Shell', tenantId: 'tenant_a', userId: 'user_a' });
  const b = reg.request({ name: 'Write', tenantId: 'tenant_a', userId: 'user_a' });

  assert.deepEqual(reg.resolveMany([a.id, b.id], 'session', { tenantId: 'tenant_b', userId: 'user_a' }), [
    { id: a.id, ok: false },
    { id: b.id, ok: false },
  ]);
  assert.deepEqual(reg.resolveMany([a.id, 'ghost', b.id, a.id], 'session', { tenantId: 'tenant_a', userId: 'user_a' }), [
    { id: a.id, ok: true },
    { id: 'ghost', ok: false },
    { id: b.id, ok: true },
  ]);
  assert.equal(await a.promise, 'session');
  assert.equal(await b.promise, 'session');
});

test('approval registry rejects resolve attempts from the wrong tenant/user scope', async () => {
  const reg = createApprovalRegistry();
  const { id, promise } = reg.request({ name: 'Shell', tenantId: 'tenant_a', userId: 'user_a' });
  assert.equal(reg.resolve(id, 'once', { tenantId: 'tenant_b', userId: 'user_a' }), false);
  assert.equal(reg.respond(id, 'ok', { tenantId: 'tenant_a', userId: 'user_b' }), false);
  assert.equal(reg.resolve(id, 'once', { tenantId: 'tenant_a', userId: 'user_a' }), true);
  assert.equal(await promise, 'once');
});

test('high-risk tool is gated behind approval (approve once)', async () => {
  let executed = false;
  const approvals = createApprovalRegistry();
  let asked = 0;
  const out = await runAgentChat({
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: tmp(), runStoreRoot: path.join(tmp(), 'runs'),
    tools: [tool('Shell', 'high', () => { executed = true; })], modelCall: callThenAnswer('Shell'), approvals,
    emit: (t, d) => { if (t === 'approval_request') { asked += 1; approvals.resolve(d.id, 'once'); } },
  });
  assert.equal(asked, 1);
  assert.equal(executed, true);
  assert.equal(out.text, '完成。');
});

test('rejected high-risk tool does not run', async () => {
  let executed = false;
  const approvals = createApprovalRegistry();
  const out = await runAgentChat({
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: tmp(), runStoreRoot: path.join(tmp(), 'runs'),
    tools: [tool('Shell', 'high', () => { executed = true; })], modelCall: callThenAnswer('Shell'), approvals,
    emit: (t, d) => { if (t === 'approval_request') approvals.resolve(d.id, 'reject'); },
  });
  assert.equal(executed, false);
  assert.ok(out.steps.some((s) => s.tool === 'Shell' && s.rejected));
});

test('requiresApproval and critical risk tools are gated even when not mutating', async () => {
  const root = tmp();
  const approvals = createApprovalRegistry();
  let gatedRan = false;
  let criticalRan = false;
  let asked = 0;
  const out = await runAgentChat({
    prompt: 'x',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
    tools: [
      { name: 'NeedsReceipt', risk: 'low', requiresApproval: true, description: 'receipt', parameters: { type: 'object', properties: {} }, handler: async () => { gatedRan = true; return { ok: true }; } },
      { name: 'CriticalRead', risk: 'critical', mutating: false, description: 'critical', parameters: { type: 'object', properties: {} }, handler: async () => { criticalRan = true; return { ok: true }; } },
    ],
    modelCall: callThenAnswer('NeedsReceipt'),
    approvals,
    emit: (t, d) => { if (t === 'approval_request') { asked += 1; approvals.resolve(d.id, 'reject'); } },
  });
  assert.equal(asked, 1);
  assert.equal(gatedRan, false);
  assert.equal(criticalRan, false);
  assert.ok(out.steps.some((s) => s.tool === 'NeedsReceipt' && s.rejected));

  const approvals2 = createApprovalRegistry();
  await runAgentChat({
    prompt: 'x',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs2'),
    tools: [
      { name: 'CriticalRead', risk: 'critical', mutating: false, description: 'critical', parameters: { type: 'object', properties: {} }, handler: async () => { criticalRan = true; return { ok: true }; } },
    ],
    modelCall: callThenAnswer('CriticalRead'),
    approvals: approvals2,
    emit: (t, d) => { if (t === 'approval_request') approvals2.resolve(d.id, 'reject'); },
  });
  assert.equal(criticalRan, false);
});

test('low-risk tool runs WITHOUT approval (better UX)', async () => {
  let executed = false;
  const approvals = createApprovalRegistry();
  let asked = 0;
  await runAgentChat({
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: tmp(), runStoreRoot: path.join(tmp(), 'runs'),
    tools: [tool('Write', 'low', () => { executed = true; })], modelCall: callThenAnswer('Write'), approvals,
    emit: (t) => { if (t === 'approval_request') asked += 1; },
  });
  assert.equal(asked, 0, 'low-risk tool must not prompt for approval');
  assert.equal(executed, true);
});

test('autoApprove auto-approves non-high mutations but high-risk stays explicit', async () => {
  // New tightened policy: autoApprove covers low/medium mutations, but a high-risk
  // tool (Shell / external MCP) ALWAYS prompts even under autoApprove.
  const approvals = createApprovalRegistry();
  let writeRan = false;
  let askedFor = null;
  await runAgentChat({
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: tmp(), runStoreRoot: path.join(tmp(), 'runs'),
    tools: [mutatingTool('SaveDraft', 'write', () => { writeRan = true; })],
    modelCall: callThenAnswer('SaveDraft'), approvals, autoApprove: true,
    emit: (t, d) => { if (t === 'approval_request') askedFor = d.name; },
  });
  assert.equal(askedFor, null, 'non-high mutation is auto-approved under autoApprove');
  assert.equal(writeRan, true);

  const approvals2 = createApprovalRegistry();
  let shellRan = false;
  let asked2 = 0;
  await runAgentChat({
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: tmp(), runStoreRoot: path.join(tmp(), 'runs'),
    tools: [mutatingTool('Shell', 'high', () => { shellRan = true; })],
    modelCall: callThenAnswer('Shell'), approvals: approvals2, autoApprove: true,
    emit: (t, d) => { if (t === 'approval_request') { asked2 += 1; approvals2.resolve(d.id, 'reject'); } },
  });
  assert.equal(asked2, 1, 'high-risk still prompts under autoApprove');
  assert.equal(shellRan, false, 'rejected high-risk does not run even under autoApprove');
});

test('POST /api/agent/chat/stream gates Shell, proceeds after POST /api/approvals/:id', async () => {
  const root = tmp();
  const agentModelCall = callThenAnswer('Shell', { command: 'node -e "process.stdout.write(String(1+1))"' });
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '跑个命令' }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let aprId = null;
    while (!aprId) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /event: approval_request\r?\ndata: (\{.*\})/.exec(all);
      if (m) aprId = JSON.parse(m[1]).id;
    }
    assert.ok(aprId, 'Shell triggered an approval_request');
    const ap = await fetch(`${base}/api/approvals/${aprId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'once' }) });
    assert.equal((await ap.json()).ok, true);
    for (;;) { const { value, done } = await reader.read(); if (done) break; all += dec.decode(value, { stream: true }); }
    assert.match(all, /event: done/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('POST /api/approvals/batch resolves only exact IDs in the caller scope', async () => {
  const root = tmp();
  const approvalRegistry = createApprovalRegistry();
  const first = approvalRegistry.request({ name: 'Shell', tenantId: 'tenant_a', userId: 'user_a' });
  const second = approvalRegistry.request({ name: 'Write', tenantId: 'tenant_a', userId: 'user_a' });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    trustIdentityHeaders: true,
    approvalRegistry,
  });
  const base = await bind(server);
  try {
    const wrong = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant_b', 'x-user-id': 'user_b' },
      body: JSON.stringify({ ids: [first.id, second.id], decision: 'once' }),
    });
    assert.equal(wrong.status, 404, 'different tenant cannot batch-resolve approvals');
    const wrongBody = await wrong.json();
    assert.equal(wrongBody.context.tenantId, 'tenant_b');
    assert.equal(wrongBody.context.userId, 'user_b');
    assert.deepEqual(wrongBody.ids, [first.id, second.id]);
    assert.equal(wrongBody.ok, false);
    assert.equal(wrongBody.resolved, 0);
    assert.deepEqual(wrongBody.results, [{ id: first.id, ok: false }, { id: second.id, ok: false }]);
    assert.equal(wrongBody.decision, 'once');

    const owner = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant_a', 'x-user-id': 'user_a' },
      body: JSON.stringify({ ids: [first.id, 'ghost', second.id, first.id], decision: 'session' }),
    });
    assert.equal(owner.status, 200);
    const ownerBody = await owner.json();
    assert.equal(ownerBody.context.tenantId, 'tenant_a');
    assert.equal(ownerBody.context.userId, 'user_a');
    assert.deepEqual(ownerBody.ids, [first.id, 'ghost', second.id]);
    assert.equal(ownerBody.ok, false);
    assert.equal(ownerBody.resolved, 2);
    assert.deepEqual(ownerBody.results, [{ id: first.id, ok: true }, { id: 'ghost', ok: false }, { id: second.id, ok: true }]);
    assert.equal(ownerBody.decision, 'session');
    assert.equal(await first.promise, 'session');
    assert.equal(await second.promise, 'session');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('POST /api/approvals/batch rejects invalid ids', async () => {
  const root = tmp();
  const approvalRegistry = createApprovalRegistry();
  const server = createServer({ trustedRoot: root, enableScheduler: false, approvalRegistry });
  const base = await bind(server);
  try {
    const invalid = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['apr_ok', '../bad'], decision: 'once' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /ids/i);

    const empty = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [], decision: 'once' }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('POST /api/approvals/:id rejects a different tenant before resolving a tool approval', async () => {
  const root = tmp();
  const agentModelCall = callThenAnswer('Shell', { command: 'node -e "process.stdout.write(String(1+1))"' });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    trustIdentityHeaders: true,
    kimiChatRunner: async () => ({}),
    agentModelCall,
  });
  const base = await bind(server);
  try {
    const ownerHeaders = {
      'content-type': 'application/json',
      'x-tenant-id': 'tenant_a',
      'x-user-id': 'user_a',
    };
    const res = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ prompt: '跑个命令' }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let all = '';
    let aprId = null;
    while (!aprId) {
      const { value, done } = await reader.read();
      if (done) break;
      all += dec.decode(value, { stream: true });
      const m = /event: approval_request\r?\ndata: (\{.*\})/.exec(all);
      if (m) aprId = JSON.parse(m[1]).id;
    }
    assert.ok(aprId, 'Shell triggered an approval_request');

    const wrong = await fetch(`${base}/api/approvals/${aprId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant_b', 'x-user-id': 'user_b' },
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(wrong.status, 404, 'different tenant cannot resolve the approval');
    assert.equal((await wrong.json()).ok, false);

    const owner = await fetch(`${base}/api/approvals/${aprId}`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(owner.status, 200);
    assert.equal((await owner.json()).ok, true);
    for (;;) { const { value, done } = await reader.read(); if (done) break; all += dec.decode(value, { stream: true }); }
    assert.match(all, /event: done/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
