import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { runSubagent } from '../src/runtime/subagent.js';
import { LocalSubprocessSandbox } from '../src/sandbox/local-sandbox.js';
import { DEFAULT_ALLOW_TOOLS } from '../src/sandbox/index.js';
import { readRunRecord } from '../src/runtime/run-store.js';
import { createServer } from '../src/server.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tools-'));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function createToolsServer(config = {}) {
  return createServer({ requireAuth: false, trustIdentityHeaders: true, ...config });
}

// ---- registry ----

test('ToolRegistry.list returns descriptors without leaking handlers', () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'a.tool', description: 'does a', risk: 'high', mutating: true, requiresApproval: true, handler: () => 1 });
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'a.tool');
  assert.equal(list[0].risk, 'high');
  assert.equal(list[0].mutating, true);
  assert.equal(list[0].requiresApproval, true);
  assert.equal('handler' in list[0], false);
});

test('ToolRegistry.search ranks name hits above description hits and respects empty query', () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'sandbox.exec', description: 'run a command', handler: () => {} });
  registry.register({ name: 'recipe.email-draft', description: 'draft an email in the sandbox style', handler: () => {} });
  const hits = registry.search('sandbox');
  assert.equal(hits[0].name, 'sandbox.exec', 'name hit ranks first');
  assert.ok(hits.some((h) => h.name === 'recipe.email-draft'), 'description hit still included');
  const all = registry.search('', { limit: 1 });
  assert.equal(all.length, 1, 'empty query returns the list capped by limit');
});

test('ToolRegistry.call invokes the handler; unknown tool throws 404', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'add', description: '', handler: (args) => args.a + args.b });
  assert.equal(await registry.call('add', { a: 2, b: 3 }), 5);
  await assert.rejects(() => registry.call('missing'), (err) => {
    assert.equal(err.statusCode, 404);
    return true;
  });
});

test('ToolRegistry.registerMcpClient imports namespaced tools and forwards calls', async () => {
  const calls = [];
  const fakeMcp = {
    connected: false,
    async connect() { this.connected = true; },
    async listTools() { return [{ name: 'echo', description: 'echo text' }]; },
    async callTool(name, args) { calls.push([name, args]); return { content: [{ type: 'text', text: `echo:${args.text}` }] }; },
  };
  const registry = new ToolRegistry();
  const count = await registry.registerMcpClient('demo', fakeMcp);
  assert.equal(count, 1);
  assert.equal(fakeMcp.connected, true);
  assert.equal(registry.has('mcp__demo__echo'), true);
  assert.deepEqual(registry.mcpServers(), ['demo']);
  const result = await registry.call('mcp__demo__echo', { text: 'hi' });
  assert.equal(result.content[0].text, 'echo:hi');
  assert.deepEqual(calls, [['echo', { text: 'hi' }]]);
});

// ---- built-in tools ----

test('createBuiltinTools exposes sandbox + recipe tools and sandbox.exec actually runs', async () => {
  const root = tempRoot();
  const sandbox = new LocalSubprocessSandbox();
  const tools = createBuiltinTools({ sandbox, sandboxLimits: { allowTools: DEFAULT_ALLOW_TOOLS }, runStoreRoot: path.join(root, 'runs') });
  const registry = new ToolRegistry().registerMany(tools);
  assert.equal(registry.has('sandbox.exec'), true);
  assert.equal(registry.has('sandbox.run-code'), true);
  assert.equal(registry.has('recipe.meeting-actions'), true);
  assert.equal(registry.descriptor('sandbox.exec').requiresApproval, true);
  const result = await registry.call(
    'sandbox.exec',
    { tool: 'node', args: ['-e', 'process.stdout.write("agent-ok")'], timeoutMs: 5000 },
    { trustedRoot: root },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'agent-ok');
});

// ---- subagent orchestrator ----

test('runSubagent executes steps in order and records a subagent-run', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const registry = new ToolRegistry();
  const order = [];
  registry.register({ name: 'step.one', description: '', handler: () => { order.push('one'); return { runId: 'r1', ok: true }; } });
  registry.register({ name: 'step.two', description: '', handler: () => { order.push('two'); return { exitCode: 0 }; } });

  const out = await runSubagent({
    goal: '跑两步',
    steps: [{ tool: 'step.one' }, { tool: 'step.two', args: { x: 1 } }],
    registry,
    trustedRoot: root,
    runStoreRoot,
    context: { tenantId: 'tenant_t', userId: 'user_u' },
  });

  assert.equal(out.ok, true);
  assert.deepEqual(order, ['one', 'two']);
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].summary.runId, 'r1');
  assert.equal(out.steps[1].summary.exitCode, 0);

  const record = readRunRecord(runStoreRoot, out.runId);
  assert.equal(record.type, 'subagent-run');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.result.steps.length, 2);
});

test('runSubagent stops on the first failing step', async () => {
  const root = tempRoot();
  const registry = new ToolRegistry();
  let secondRan = false;
  registry.register({ name: 'bad', description: '', handler: () => { throw new Error('kaboom'); } });
  registry.register({ name: 'after', description: '', handler: () => { secondRan = true; } });
  const out = await runSubagent({
    goal: 'fail fast',
    steps: [{ tool: 'bad' }, { tool: 'after' }],
    registry,
    trustedRoot: root,
    runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(out.ok, false);
  assert.equal(secondRan, false);
  assert.equal(out.steps[0].status, 'failed');
  assert.match(out.steps[0].error, /kaboom/);
});

test('runSubagent rejects an unknown tool with 400', async () => {
  const root = tempRoot();
  const registry = new ToolRegistry();
  registry.register({ name: 'known', description: '', handler: () => {} });
  await assert.rejects(
    () => runSubagent({ steps: [{ tool: 'ghost' }], registry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    (err) => { assert.equal(err.statusCode, 400); return true; },
  );
});

// ---- route integration ----

test('GET /api/tools lists built-in tools (sandbox + recipes)', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/tools');
    assert.equal(res.status, 200);
    const names = res.body.tools.map((t) => t.name);
    assert.ok(names.includes('sandbox.exec'));
    assert.ok(names.includes('sandbox.run-code'));
    assert.ok(names.some((n) => n.startsWith('recipe.')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/tools/search ranks matching tools', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/tools/search?q=sandbox&limit=5');
    assert.equal(res.status, 200);
    assert.equal(res.body.query, 'sandbox');
    assert.ok(res.body.tools.length >= 1);
    assert.ok(res.body.tools.every((t) => typeof t.score === 'number'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/tools/call invokes a read-only tool, is idempotent, and 404s unknown tools', async () => {
  const trustedRoot = tempRoot();
  fs.writeFileSync(path.join(trustedRoot, 'notes.txt'), 'tool-ok search target', 'utf8');
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_call', 'idempotency-key': 'call-1' };
    const body = { name: 'SearchWorkspace', args: { query: 'tool-ok', limit: 3 } };
    const first = await jsonRequest(base, '/api/tools/call', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal(first.body.name, 'SearchWorkspace');
    assert.ok(first.body.result.chunks.length >= 1);

    const second = await jsonRequest(base, '/api/tools/call', { method: 'POST', headers, body });
    assert.equal(second.body.idempotentReplay, true);

    const unknown = await jsonRequest(base, '/api/tools/call', {
      method: 'POST',
      headers: { 'idempotency-key': 'call-x' },
      body: { name: 'does.not.exist', args: {} },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/tools/call rejects approval-gated tools', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/tools/call', {
      method: 'POST',
      headers: { 'idempotency-key': 'call-gated' },
      body: { name: 'sandbox.exec', args: { tool: 'node', args: ['-e', 'process.stdout.write("blocked")'], timeoutMs: 5000 } },
    });
    assert.equal(res.status, 428);
    assert.match(res.body.error, /requires agent approval/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/tools/call requires an Idempotency-Key', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/tools/call', {
      method: 'POST',
      body: { name: 'sandbox.exec', args: { tool: 'node', args: ['-e', ''] } },
    });
    assert.equal(res.status, 428);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/subagent/run executes a multi-step plan and records a subagent-run', async () => {
  const trustedRoot = tempRoot();
  fs.writeFileSync(path.join(trustedRoot, 'a.txt'), 'alpha route target', 'utf8');
  fs.writeFileSync(path.join(trustedRoot, 'b.txt'), 'beta route target', 'utf8');
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_agent', 'idempotency-key': 'agent-1' };
    const body = {
      goal: '检索两段文本',
      steps: [
        { tool: 'SearchWorkspace', args: { query: 'alpha', limit: 3 } },
        { tool: 'SearchWorkspace', args: { query: 'beta', limit: 3 } },
      ],
    };
    const res = await jsonRequest(base, '/api/subagent/run', { method: 'POST', headers, body });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.steps.length, 2);
    assert.ok(res.body.steps[0].summary.keys.includes('chunks'));
    assert.match(res.body.runId, /^run_/);

    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_agent' } });
    assert.equal(index.body.runs.length, 1);
    assert.equal(index.body.runs[0].type, 'subagent-run');

    const replay = await jsonRequest(base, '/api/subagent/run', { method: 'POST', headers, body });
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.runId, res.body.runId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/subagent/run rejects approval-gated steps', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/subagent/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'agent-gated' },
      body: {
        goal: 'blocked sandbox',
        steps: [
          { tool: 'sandbox.exec', args: { tool: 'node', args: ['-e', 'process.stdout.write("blocked")'], timeoutMs: 5000 } },
        ],
      },
    });
    assert.equal(res.status, 428);
    assert.match(res.body.error, /requires agent approval/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
