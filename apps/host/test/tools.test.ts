import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo, Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { argsRecord, contextRecord, parseBuiltinToolsOptions } from '../src/tools/builtin-tool-options.js';
import { parseMcpTools, parseToolEntry } from '../src/tools/tool-registry-inputs.js';
import { runSubagent } from '../src/runtime/subagent.js';
import { runSubagentsParallel } from '../src/runtime/subagent-parallel.js';
import { LocalSubprocessSandbox } from '../src/sandbox/local-sandbox.js';
import { DEFAULT_ALLOW_TOOLS } from '../src/sandbox/index.js';
import { readRunRecord } from '../src/runtime/run-store.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import type { McpClient, ToolDescriptor } from '../src/tools/tool-registry.js';
import type { ServerConfig, HostServer } from '../src/server.js';
import type { SubagentStepResult } from '../src/runtime/subagent.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tools-'));
}

type JsonRequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
type JsonResponse = { status: number; body: Record<string, unknown> };

function noop() {
  return undefined;
}

async function bind(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  const { port } = address as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function jsonRequest(base: string, route: string, { method = 'GET', body, headers = {} }: JsonRequestOptions = {}): Promise<JsonResponse> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body != null) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

function createToolsServer(config: Partial<ServerConfig> = {}): HostServer {
  return createServer({ requireAuth: false, trustIdentityHeaders: true, ...config });
}

function itemAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  assert.ok(item, `${label} should exist`);
  return item;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  const text = value;
  if (typeof text === 'string') {
    return text;
  }
  throw new Error(`${label} should be a string`);
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

function bodyRecord(response: JsonResponse, label: string): Record<string, unknown> {
  return recordValue(response.body, `${label} body`);
}

function descriptorValue(value: ToolDescriptor | null, label: string): ToolDescriptor {
  assert.ok(value, `${label} descriptor should exist`);
  return value;
}

function succeededStep(step: SubagentStepResult | undefined, label: string): Extract<SubagentStepResult, { status: 'succeeded' }> {
  assert.ok(step, `${label} should exist`);
  assert.equal(step.status, 'succeeded');
  return step as Extract<SubagentStepResult, { status: 'succeeded' }>;
}

function failedStep(step: SubagentStepResult | undefined, label: string): Extract<SubagentStepResult, { status: 'failed' }> {
  assert.ok(step, `${label} should exist`);
  assert.equal(step.status, 'failed');
  return step as Extract<SubagentStepResult, { status: 'failed' }>;
}

function assertHttpStatus(err: unknown, statusCode: number): boolean {
  assert.equal((err as { statusCode?: unknown }).statusCode, statusCode);
  return true;
}

// ---- registry ----

test('tool boundary parsers reject polluted setup before registering or running tools', () => {
  const handler = () => ({ ok: true });
  assert.deepEqual(parseToolEntry({
    name: '  custom.read  ',
    description: 'Read only',
    source: 'test',
    inputSchema: { type: 'object' },
    risk: 'safe',
    mutating: false,
    requiresApproval: false,
    handler,
  }), {
    name: 'custom.read',
    description: 'Read only',
    source: 'test',
    inputSchema: { type: 'object' },
    risk: 'safe',
    mutating: false,
    requiresApproval: false,
    handler,
  });

  assert.throws(
    () => parseToolEntry({ name: 'bad', handler, extra: true }),
    (error: unknown) => error instanceof Error
      && /ToolRegistry\.register: Unrecognized key/.test(error.message)
      && assertHttpStatus(error, 400),
  );
  assert.throws(
    () => parseToolEntry({ name: 'bad', handler: 'not-a-function' }),
    /handler must be a function/,
  );
  assert.deepEqual(parseMcpTools([{ name: 'mcp.read', description: 'Read', extra: true }]), [
    { name: 'mcp.read', description: 'Read' },
  ]);
  assert.throws(
    () => parseMcpTools([{ name: '   ' }]),
    /ToolRegistry\.registerMcpClient: 0.name: name is required/,
  );
});

test('builtin tool options and handler context parsers fail closed on wrong dependency shapes', () => {
  const sandbox = { exec: async () => ({ ok: true }) };
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
  assert.deepEqual(parseBuiltinToolsOptions({
    sandbox,
    runStoreRoot: 'runs',
    runEvents: null,
    runsIndex: null,
    enableWebTools: true,
    fetchImpl,
  }), {
    sandbox,
    runStoreRoot: 'runs',
    runEvents: null,
    runsIndex: null,
    enableWebTools: true,
    fetchImpl,
  });
  assert.deepEqual(argsRecord({ path: 'a.txt' }), { path: 'a.txt' });
  assert.deepEqual(argsRecord(['not', 'record']), {});
  assert.deepEqual(contextRecord({ trustedRoot: 'C:/workspace' }), { trustedRoot: 'C:/workspace' });
  assert.deepEqual(contextRecord(null), {});

  assert.throws(
    () => parseBuiltinToolsOptions({ sandbox: { exec: 'bad' } }),
    (error: unknown) => error instanceof Error
      && /createBuiltinTools: sandbox: sandbox must expose exec/.test(error.message)
      && assertHttpStatus(error, 400),
  );
  assert.throws(
    () => parseBuiltinToolsOptions({ fetchImpl: 'bad' }),
    /createBuiltinTools: fetchImpl: fetchImpl must be a function/,
  );
  assert.throws(
    () => parseBuiltinToolsOptions({ enableWebTools: 'yes' }),
    /createBuiltinTools: enableWebTools/,
  );
});

test('ToolRegistry.list returns descriptors without leaking handlers', () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'a.tool', description: 'does a', risk: 'high', mutating: true, requiresApproval: true, handler: () => 1 });
  const list = registry.list();
  const descriptor = itemAt(list, 0, 'registered tool');
  assert.equal(list.length, 1);
  assert.equal(descriptor.name, 'a.tool');
  assert.equal(descriptor.risk, 'high');
  assert.equal(descriptor.mutating, true);
  assert.equal(descriptor.requiresApproval, true);
  assert.equal('handler' in descriptor, false);
});

test('ToolRegistry.register rejects malformed descriptors before storage', () => {
  const registry = new ToolRegistry();
  assert.throws(
    () => registry.register({ name: 'bad.tool', handler: () => 1, raw: true }),
    /ToolRegistry\.register: .*raw/i,
  );
  assert.equal(registry.has('bad.tool'), false);
  assert.throws(
    () => registry.register({ name: 'bad.tool' }),
    /ToolRegistry\.register: .*handler/i,
  );
});

test('ToolRegistry.search ranks name hits above description hits and respects empty query', () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'sandbox.exec', description: 'run a command', handler: () => undefined });
  registry.register({ name: 'recipe.email-draft', description: 'draft an email in the sandbox style', handler: () => undefined });
  const hits = registry.search('sandbox');
  assert.equal(itemAt(hits, 0, 'search hit').name, 'sandbox.exec', 'name hit ranks first');
  assert.ok(hits.some((h) => h.name === 'recipe.email-draft'), 'description hit still included');
  const all = registry.search('', { limit: 1 });
  assert.equal(all.length, 1, 'empty query returns the list capped by limit');
});

test('ToolRegistry.call invokes the handler; unknown tool throws 404', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'add', description: '', handler: (args: unknown) => {
    const input = recordValue(args, 'add args');
    return Number(input.a) + Number(input.b);
  } });
  assert.equal(await registry.call('add', { a: 2, b: 3 }), 5);
  await assert.rejects(() => registry.call('missing'), (err) => {
    return assertHttpStatus(err, 404);
  });
});

test('ToolRegistry.registerMcpClient imports namespaced tools and forwards calls', async () => {
  const calls: Array<[string, unknown]> = [];
  const fakeMcp: McpClient & { connected: boolean } = {
    connected: false,
    async connect() { this.connected = true; },
    async listTools() { return [{ name: 'echo', description: 'echo text' }]; },
    async callTool(name: string, args: unknown) {
      const input = recordValue(args, 'mcp args');
      calls.push([name, args]);
      return { content: [{ type: 'text', text: `echo:${input.text}` }] };
    },
  };
  const registry = new ToolRegistry();
  const count = await registry.registerMcpClient('demo', fakeMcp);
  assert.equal(count, 1);
  assert.equal(fakeMcp.connected, true);
  assert.equal(registry.has('mcp__demo__echo'), true);
  assert.equal(descriptorValue(registry.descriptor('mcp__demo__echo'), 'mcp echo').requiresApproval, true);
  assert.equal(descriptorValue(registry.descriptor('mcp__demo__echo'), 'mcp echo').risk, 'high');
  assert.deepEqual(registry.mcpServers(), ['demo']);
  const result = await registry.call('mcp__demo__echo', { text: 'hi' });
  const content = recordArray(recordValue(result, 'mcp result').content, 'mcp result content');
  assert.equal(itemAt(content, 0, 'mcp text content').text, 'echo:hi');
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
  assert.equal(descriptorValue(registry.descriptor('sandbox.exec'), 'sandbox.exec').requiresApproval, true);
  const result = await registry.call(
    'sandbox.exec',
    { tool: 'node', args: ['-e', 'process.stdout.write("agent-ok")'], timeoutMs: 5000 },
    { trustedRoot: root },
  );
  const resultRecord = recordValue(result, 'sandbox.exec result');
  assert.equal(resultRecord.exitCode, 0);
  assert.equal(resultRecord.stdout, 'agent-ok');
});

test('createBuiltinTools rejects unknown assembly options', () => {
  assert.throws(
    () => createBuiltinTools({ sandbox: null, raw: true } as unknown as Parameters<typeof createBuiltinTools>[0]),
    /createBuiltinTools: .*raw/i,
  );
});

// ---- subagent orchestrator ----

test('runSubagent executes steps in order and records a subagent-run', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const registry = new ToolRegistry();
  const order: string[] = [];
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
  assert.equal(succeededStep(out.steps[0], 'first subagent step').summary.runId, 'r1');
  assert.equal(succeededStep(out.steps[1], 'second subagent step').summary.exitCode, 0);

  const record = readRunRecord(runStoreRoot, out.runId);
  assert.ok(record, 'subagent run record should exist');
  assert.equal(record.type, 'subagent-run');
  assert.equal(record.status, 'succeeded');
  assert.equal(recordArray(recordValue(record.result, 'subagent record result').steps, 'subagent record steps').length, 2);
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
  assert.match(failedStep(out.steps[0], 'failed subagent step').error, /kaboom/);
});

test('runSubagent preserves failed-step history, summaries, event publishing, and index isolation', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const registry = new ToolRegistry();
  registry.register({ name: 'value.step', description: '', handler: () => 'plain value' });
  registry.register({ name: 'content.step', description: '', handler: () => ({ content: [{ text: 'alpha' }, { text: 'beta' }] }) });
  registry.register({ name: 'keys.step', description: '', handler: () => ({ a: 1, b: 2, c: 3 }) });
  registry.register({ name: 'bad.step', description: '', handler: () => { throw new Error('tool failed'); } });
  registry.register({ name: 'after.step', description: '', handler: () => ({ exitCode: 1, timedOut: true }) });

  const published: Record<string, unknown>[] = [];
  const indexCalls: unknown[] = [];
  const out = await runSubagent({
    goal: '',
    steps: [
      { tool: 'value.step' },
      { tool: 'content.step' },
      { tool: 'keys.step' },
      { tool: 'bad.step' },
      { tool: 'after.step' },
    ],
    registry,
    trustedRoot: root,
    runStoreRoot,
    runEvents: {
      publish(_runId, payload) {
        const event = { ...payload, type: String(payload.type || 'event'), seq: published.length + 1, ts: '2026-06-19T00:00:00.000Z' };
        published.push(event);
        return event;
      },
    },
    runsIndex: {
      upsert(record) {
        indexCalls.push(record);
        throw new Error('index down');
      },
    },
    stopOnError: false,
  });

  assert.equal(out.ok, false);
  assert.equal(out.steps.length, 5);
  assert.equal(succeededStep(out.steps[0], 'primitive summary').summary.value, 'plain value');
  assert.equal(succeededStep(out.steps[1], 'content summary').summary.content, 'alpha beta');
  assert.deepEqual(succeededStep(out.steps[2], 'keys summary').summary.keys, ['a', 'b', 'c']);
  assert.match(failedStep(out.steps[3], 'continued failed step').error, /tool failed/);
  assert.deepEqual(succeededStep(out.steps[4], 'post-failure exit summary').summary, { exitCode: 1, ok: false });
  assert.equal(out.events[0]?.type, 'user_message');
  assert.equal(out.events[0]?.seq, 1);
  assert.equal(indexCalls.length, 1);

  const record = readRunRecord(runStoreRoot, out.runId);
  assert.ok(record, 'subagent run record should still be written when index upsert fails');
  assert.equal(record.status, 'failed');
});

test('runSubagent rejects missing dependencies and malformed step limits before running tools', async () => {
  const root = tempRoot();
  const registry = new ToolRegistry();
  registry.register({ name: 'safe.read', description: '', handler: noop });

  await assert.rejects(
    () => runSubagent({ steps: [{ tool: 'safe.read' }], registry: null as unknown as ToolRegistry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    /registry is required/,
  );
  await assert.rejects(
    () => runSubagent({ steps: [{ tool: 'safe.read' }], registry, trustedRoot: root, runStoreRoot: '' }),
    /runStoreRoot is required/,
  );
  await assert.rejects(
    () => runSubagent({ steps: [], registry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    (err) => assertHttpStatus(err, 400),
  );
  await assert.rejects(
    () => runSubagent({ steps: [{}], registry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    (err) => assertHttpStatus(err, 400),
  );
  await assert.rejects(
    () => runSubagent({
      steps: [{ tool: 'safe.read' }, { tool: 'safe.read' }],
      registry,
      trustedRoot: root,
      runStoreRoot: path.join(root, 'runs'),
      maxSteps: 1,
    }),
    (err) => assertHttpStatus(err, 400),
  );
});

test('runSubagent rejects an unknown tool with 400', async () => {
  const root = tempRoot();
  const registry = new ToolRegistry();
  registry.register({ name: 'known', description: '', handler: noop });
  await assert.rejects(
    () => runSubagent({ steps: [{ tool: 'ghost' }], registry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    (err) => assertHttpStatus(err, 400),
  );
});

test('runSubagent rejects over-budget context before executing steps', async () => {
  const root = tempRoot();
  const registry = new ToolRegistry();
  let called = false;
  registry.register({ name: 'safe.read', description: '', handler: () => { called = true; return { ok: true }; } });

  await assert.rejects(
    () => runSubagent({
      goal: 'x'.repeat(128),
      steps: [{ tool: 'safe.read', args: { q: 'alpha' } }],
      registry,
      trustedRoot: root,
      runStoreRoot: path.join(root, 'runs'),
      contextBudgetBytes: 64,
    }),
    (err) => assertHttpStatus(err, 413),
  );
  assert.equal(called, false);
});

test('runSubagentsParallel runs child agents concurrently and records an aggregate run', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const registry = new ToolRegistry();
  let active = 0;
  let maxActive = 0;
  registry.register({
    name: 'slow.read',
    description: '',
    risk: 'low',
    mutating: false,
    handler: async (args: unknown) => {
      const input = recordValue(args, 'slow.read args');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 80));
      active -= 1;
      return { label: input.label };
    },
  });

  const out = await runSubagentsParallel({
    goal: '并行分析',
    agents: ['a', 'b', 'c'].map((label) => ({
      goal: `分析 ${label}`,
      steps: [{ tool: 'slow.read', args: { label } }],
    })),
    registry,
    trustedRoot: root,
    runStoreRoot,
    maxConcurrency: 3,
    context: { tenantId: 'tenant_parallel', userId: 'user_parallel' },
  });

  assert.equal(out.ok, true);
  assert.equal(out.children.length, 3);
  assert.ok(maxActive > 1, `expected concurrent child agents, saw maxActive=${maxActive}`);
  assert.deepEqual(out.children.map((child) => child.status), ['succeeded', 'succeeded', 'succeeded']);

  const record = readRunRecord(runStoreRoot, out.runId);
  assert.ok(record, 'parallel run record should exist');
  assert.equal(record.type, 'subagent-parallel-run');
  assert.equal(recordArray(recordValue(record.result, 'parallel record result').children, 'parallel record children').length, 3);
});

test('runSubagentsParallel rejects an over-budget child before executing any child agent', async () => {
  const root = tempRoot();
  const registry = new ToolRegistry();
  let called = false;
  registry.register({ name: 'safe.read', description: '', handler: () => { called = true; return { ok: true }; } });

  await assert.rejects(
    () => runSubagentsParallel({
      goal: '并行预算',
      agents: [
        { goal: 'ok', steps: [{ tool: 'safe.read', args: { q: 'alpha' } }] },
        { goal: 'x'.repeat(128), steps: [{ tool: 'safe.read', args: { q: 'beta' } }] },
      ],
      registry,
      trustedRoot: root,
      runStoreRoot: path.join(root, 'runs'),
      contextBudgetBytes: 64,
    }),
    (err) => assertHttpStatus(err, 413),
  );
  assert.equal(called, false);
});

test('runSubagentsParallel records child startup failures and still writes the aggregate run', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const registry = new ToolRegistry();
  registry.register({ name: 'safe.read', description: '', handler: () => ({ ok: true }) });
  const indexCalls: unknown[] = [];

  const out = await runSubagentsParallel({
    goal: '',
    agents: [
      { task: 'will fail during child event setup', steps: [{ tool: 'safe.read' }] },
    ],
    registry,
    trustedRoot: root,
    runStoreRoot,
    runEvents: {
      publish(_runId, payload) {
        if (payload.type === 'user_message' && String(payload.text || '').startsWith('will fail')) {
          throw new Error('event bus down');
        }
        return { ...payload, type: String(payload.type || 'event'), seq: 1, ts: '2026-06-19T00:00:00.000Z' };
      },
    },
    runsIndex: {
      upsert(record) {
        indexCalls.push(record);
        throw new Error('parallel index down');
      },
    },
  });

  assert.equal(out.ok, false);
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0]?.status, 'failed');
  assert.match(out.children[0]?.error || '', /event bus down/);
  assert.equal(indexCalls.length, 1);
  const record = readRunRecord(runStoreRoot, out.runId);
  assert.ok(record, 'parallel aggregate record should be written when a child fails before it starts');
  assert.equal(record.status, 'failed');
});

test('runSubagentsParallel rejects invalid setup before scheduling workers', async () => {
  const root = tempRoot();
  const registry = new ToolRegistry();
  registry.register({ name: 'safe.read', description: '', handler: noop });

  await assert.rejects(
    () => runSubagentsParallel({ agents: [{ steps: [{ tool: 'safe.read' }] }], registry: null as unknown as ToolRegistry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    /registry is required/,
  );
  await assert.rejects(
    () => runSubagentsParallel({ agents: [{ steps: [{ tool: 'safe.read' }] }], registry, trustedRoot: root, runStoreRoot: '' }),
    /runStoreRoot is required/,
  );
  await assert.rejects(
    () => runSubagentsParallel({ agents: [], registry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    (err) => assertHttpStatus(err, 400),
  );
  await assert.rejects(
    () => runSubagentsParallel({
      agents: [{ steps: [{ tool: 'safe.read' }] }, { steps: [{ tool: 'safe.read' }] }],
      registry,
      trustedRoot: root,
      runStoreRoot: path.join(root, 'runs'),
      maxAgents: 1,
    }),
    (err) => assertHttpStatus(err, 400),
  );
  await assert.rejects(
    () => runSubagentsParallel({ agents: [{ steps: [{}] }], registry, trustedRoot: root, runStoreRoot: path.join(root, 'runs') }),
    (err) => assertHttpStatus(err, 400),
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
    const names = recordArray(bodyRecord(res, 'tools list').tools, 'tools list').map((tool) => stringValue(tool.name, 'tool name'));
    assert.ok(names.includes('sandbox.exec'));
    assert.ok(names.includes('sandbox.run-code'));
    assert.ok(names.some((n) => n.startsWith('recipe.')));
  } finally {
    await closeTestServer(server);
  }
});

test('GET /api/tools/search ranks matching tools', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/tools/search?q=sandbox&limit=5');
    const body = bodyRecord(res, 'tools search');
    const tools = recordArray(body.tools, 'tools search tools');
    assert.equal(res.status, 200);
    assert.equal(body.query, 'sandbox');
    assert.ok(tools.length >= 1);
    assert.ok(tools.every((tool) => typeof tool.score === 'number'));
  } finally {
    await closeTestServer(server);
  }
});

test('GET /api/tools/search rejects malformed limit', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/tools/search?q=sandbox&limit=zero');
    assert.equal(res.status, 400);
    assert.match(String(bodyRecord(res, 'malformed search').error || ''), /number|limit/i);
  } finally {
    await closeTestServer(server);
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
    const firstBody = bodyRecord(first, 'first tools call');
    assert.equal(first.status, 200);
    assert.equal(firstBody.name, 'SearchWorkspace');
    assert.ok(recordArray(recordValue(firstBody.result, 'tools call result').chunks, 'tools call chunks').length >= 1);

    const second = await jsonRequest(base, '/api/tools/call', { method: 'POST', headers, body });
    assert.equal(bodyRecord(second, 'replayed tools call').idempotentReplay, true);

    const unknown = await jsonRequest(base, '/api/tools/call', {
      method: 'POST',
      headers: { 'idempotency-key': 'call-x' },
      body: { name: 'does.not.exist', args: {} },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/tools/call rejects malformed route body', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/tools/call', {
      method: 'POST',
      headers: { 'idempotency-key': 'call-malformed' },
      body: { name: 42, args: {} },
    });
    assert.equal(res.status, 400);
    assert.match(String(bodyRecord(res, 'malformed tools call').error || ''), /string|name/i);
  } finally {
    await closeTestServer(server);
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
    assert.match(String(bodyRecord(res, 'approval-gated tools call').error || ''), /requires agent approval/i);
  } finally {
    await closeTestServer(server);
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
    await closeTestServer(server);
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
    const resBody = bodyRecord(res, 'subagent run');
    const steps = recordArray(resBody.steps, 'subagent run steps');
    assert.equal(res.status, 200);
    assert.equal(resBody.ok, true);
    assert.equal(steps.length, 2);
    const firstSummary = recordValue(itemAt(steps, 0, 'first route step').summary, 'first route step summary');
    assert.ok(Array.isArray(firstSummary.keys) && firstSummary.keys.includes('chunks'));
    assert.match(stringValue(resBody.runId, 'subagent run id'), /^run_/);

    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_agent' } });
    const runs = recordArray(bodyRecord(index, 'runs index').runs, 'runs index runs');
    assert.equal(runs.length, 1);
    assert.equal(itemAt(runs, 0, 'indexed subagent run').type, 'subagent-run');

    const replay = await jsonRequest(base, '/api/subagent/run', { method: 'POST', headers, body });
    const replayBody = bodyRecord(replay, 'subagent replay');
    assert.equal(replayBody.idempotentReplay, true);
    assert.equal(replayBody.runId, resBody.runId);
  } finally {
    await closeTestServer(server);
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
    assert.match(String(bodyRecord(res, 'subagent gated').error || ''), /requires agent approval/i);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/subagent/run rejects over-budget plans before executing any tool', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/subagent/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'agent-budget' },
      body: {
        goal: 'x'.repeat(40_000),
        steps: [
          { tool: 'SearchWorkspace', args: { query: 'alpha', limit: 3 } },
        ],
      },
    });
    assert.equal(res.status, 413);
    assert.match(String(bodyRecord(res, 'subagent over budget').error || ''), /context budget exceeded/i);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/subagent/parallel runs child agents concurrently and records an aggregate run', async () => {
  const trustedRoot = tempRoot();
  const registry = new ToolRegistry();
  let active = 0;
  let maxActive = 0;
  registry.register({
    name: 'parallel.read',
    description: '',
    risk: 'low',
    mutating: false,
    handler: async (args: unknown) => {
      const input = recordValue(args, 'parallel.read args');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 80));
      active -= 1;
      return { label: input.label };
    },
  });
  const toolRegistry = registry as unknown as NonNullable<ServerConfig['toolRegistry']>;
  const server = createToolsServer({ trustedRoot, enableScheduler: false, toolRegistry });
  const base = await bind(server);
  try {
    const body = {
      goal: '并行分析三个目录',
      agents: ['one', 'two', 'three'].map((label) => ({
        goal: `分析 ${label}`,
        steps: [{ tool: 'parallel.read', args: { label } }],
      })),
    };
    const res = await jsonRequest(base, '/api/subagent/parallel', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_parallel_route', 'idempotency-key': 'agent-parallel' },
      body,
    });
    const resBody = bodyRecord(res, 'parallel route');
    const children = recordArray(resBody.children, 'parallel route children');
    assert.equal(res.status, 200);
    assert.equal(resBody.ok, true);
    assert.equal(children.length, 3);
    assert.ok(maxActive > 1, `expected concurrent route execution, saw maxActive=${maxActive}`);

    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_parallel_route' } });
    assert.ok(recordArray(bodyRecord(index, 'parallel runs index').runs, 'parallel runs').some((run) => run.type === 'subagent-parallel-run'));

    const replay = await jsonRequest(base, '/api/subagent/parallel', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_parallel_route', 'idempotency-key': 'agent-parallel' },
      body,
    });
    const replayBody = bodyRecord(replay, 'parallel replay');
    assert.equal(replayBody.idempotentReplay, true);
    assert.equal(replayBody.runId, resBody.runId);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/subagent/parallel rejects malformed route body', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/subagent/parallel', {
      method: 'POST',
      headers: { 'idempotency-key': 'agent-parallel-malformed' },
      body: { goal: 'bad', agents: 'one' },
    });
    assert.equal(res.status, 400);
    assert.match(String(bodyRecord(res, 'parallel malformed').error || ''), /agents|array/i);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/subagent/parallel rejects approval-gated child steps', async () => {
  const trustedRoot = tempRoot();
  const server = createToolsServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/subagent/parallel', {
      method: 'POST',
      headers: { 'idempotency-key': 'agent-parallel-gated' },
      body: {
        goal: 'blocked parallel sandbox',
        agents: [
          {
            goal: 'blocked',
            steps: [
              { tool: 'sandbox.exec', args: { tool: 'node', args: ['-e', 'process.stdout.write("blocked")'], timeoutMs: 5000 } },
            ],
          },
        ],
      },
    });
    assert.equal(res.status, 428);
    assert.match(String(bodyRecord(res, 'parallel gated').error || ''), /requires agent approval/i);
  } finally {
    await closeTestServer(server);
  }
});
