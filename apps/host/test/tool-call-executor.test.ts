import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeToolCall,
  type AgentTool,
  type BudgetGuard,
  type ContextManager,
  type ExecuteToolCallOptions,
  type LoopGuard,
  type RetryPolicy,
  type TodoTracker,
} from '../src/engine/agent/tool-call-executor.js';
import type { HookEngine } from '../src/engine/agent/approval-gate.js';

type EmittedEvent = { type: string; payload: Record<string, unknown> };
type AuditEvent = { kind: string; extra?: Record<string, unknown> };

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function makeCall(name: string, args: Record<string, unknown>, id = `${name}_1`) {
  return {
    id,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function createHarness({
  tool,
  retryPolicy,
  contextManager,
  budgetGuard,
  loopGuard,
  hooks,
  signal,
  autoApprove = false,
  hasApprovals = false,
}: {
  tool?: AgentTool;
  retryPolicy?: RetryPolicy;
  contextManager?: ContextManager;
  budgetGuard?: BudgetGuard;
  loopGuard?: LoopGuard;
  hooks?: HookEngine | null;
  signal?: AbortSignal | null;
  autoApprove?: boolean;
  hasApprovals?: boolean;
} = {}) {
  const events: EmittedEvent[] = [];
  const audits: AuditEvent[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const steps: Array<Record<string, unknown>> = [];
  const checkpoints: Array<{ phase: string; step: number }> = [];
  const stoppedBudgets: Record<string, unknown>[] = [];
  const todoFinishes: string[] = [];
  const toolTodos: TodoTracker = {
    start(name) {
      assert.ok(name);
      return {
        finish(status) {
          todoFinishes.push(status);
        },
      };
    },
  };
  const options: Omit<ExecuteToolCallOptions, 'call'> = {
    stepNumber: 1,
    toolMap: tool ? new Map<string, AgentTool>([[tool.name, tool]]) : new Map<string, AgentTool>(),
    activeContextManager: contextManager || {
      formatToolResult(result) {
        return { content: JSON.stringify(result) };
      },
    },
    activeRetryPolicy: retryPolicy || {
      lastRun: {},
      async run(operation) {
        return await operation();
      },
    },
    activeBudgetGuard: budgetGuard || {
      check: () => ({ shouldAbort: false }),
    },
    activeLoopGuard: loopGuard || {
      observe: () => ({ shouldBreak: false }),
    },
    toolCtx: { trustedRoot: 'C:/workspace' },
    toolTodos,
    hasApprovals,
    autoApprove,
    approvals: null,
    sessionApproved: new Set(),
    runId: 'run_1',
    planMode: false,
    planApproved: false,
    hooks: hooks || null,
    audit: (kind, extra) => {
      if (extra) audits.push({ kind, extra });
      else audits.push({ kind });
    },
    emit: (type, payload) => events.push({ type, payload: record(payload, `${type} payload`) }),
    messages,
    steps,
    context: { tenantId: 'tenant-1', userId: 'user-1' },
    runTrace: null,
    signal: signal || null,
    callbacks: {
      saveCheckpoint: (phase, step) => checkpoints.push({ phase, step }),
      stopOnBudget: (decision) => stoppedBudgets.push(decision),
    },
  };
  return {
    events,
    audits,
    messages,
    steps,
    checkpoints,
    stoppedBudgets,
    todoFinishes,
    execute: (call = makeCall(tool?.name || 'MissingTool', {}), override: Partial<Omit<ExecuteToolCallOptions, 'call'>> = {}) => (
      executeToolCall({ ...options, ...override, call })
    ),
  };
}

test('executeToolCall rejects invalid arguments before a tool handler can run', async () => {
  let handlerRuns = 0;
  const tool: AgentTool = {
    name: 'WriteReport',
    risk: 'low',
    mutating: true,
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
    handler: () => {
      handlerRuns += 1;
      return { ok: true };
    },
  };
  const harness = createHarness({ tool });

  const result = await harness.execute(makeCall('WriteReport', { path: 42 }));

  assert.deepEqual(result, {});
  assert.equal(handlerRuns, 0);
  assert.deepEqual(harness.steps, [{ tool: 'WriteReport', ok: false, invalidArgs: true }]);
  assert.deepEqual(harness.checkpoints, [{ phase: 'tool_result', step: 1 }]);
  assert.equal(harness.messages.length, 1);
  assert.match(String(harness.messages[0]?.content), /invalid tool arguments/);
  assert.ok(harness.audits.some((event) => event.kind === 'tool.args_invalid'));
  assert.ok(harness.events.some((event) => event.type === 'tool_args_invalid' && event.payload.name === 'WriteReport'));
});

test('executeToolCall blocks local strict external tools before hooks, approvals, or handlers', async () => {
  let handlerRuns = 0;
  const tool: AgentTool = {
    name: 'WebFetch',
    risk: 'safe',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    handler: () => {
      handlerRuns += 1;
      return { ok: true };
    },
  };
  const hooks: HookEngine = {
    run: () => {
      throw new Error('pre_tool hook should not run after policy denial');
    },
    blocked: () => false,
  };
  const harness = createHarness({ tool, hooks, hasApprovals: true });

  const result = await harness.execute(makeCall('WebFetch', { url: 'https://example.com' }), {
    context: { tenantId: 'tenant-1', userId: 'user-1', securityMode: 'local_strict' },
  });

  assert.deepEqual(result, {});
  assert.equal(handlerRuns, 0);
  assert.deepEqual(harness.steps, [{
    tool: 'WebFetch',
    ok: false,
    policyDenied: true,
    reasonCode: 'local_strict_blocks_external_network_tool',
  }]);
  assert.deepEqual(harness.todoFinishes, []);
  assert.ok(harness.audits.some((event) => event.kind === 'policy.decision'));
  assert.ok(harness.events.some((event) => event.type === 'policy_decision' && event.payload.decision === 'deny'));
  assert.ok(harness.events.some((event) => event.type === 'tool_result' && event.payload.status === 'blocked'));
  assert.match(String(harness.messages.at(-1)?.content), /POLICY_DENIED|local_strict/);
});

test('executeToolCall records successful mutating tool output, summaries, injection flags, and loop guard stops', async () => {
  const controller = new AbortController();
  const postHookPayloads: Array<Record<string, unknown>> = [];
  const tool: AgentTool = {
    name: 'WriteReport',
    risk: 'low',
    mutating: true,
    parameters: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    handler: (args, context) => {
      assert.equal(args?.path, 'out/report.md');
      assert.equal(context?.signal, controller.signal);
      return { ok: true, path: 'out/report.md', body: 'done' };
    },
  };
  const retryPolicy: RetryPolicy = {
    lastRun: { retried: true, attempts: 2, errors: ['temporary failure'] },
    async run(operation) {
      return await operation();
    },
  };
  const contextManager: ContextManager = {
    formatToolResult(result, { toolName }) {
      assert.equal(toolName, 'WriteReport');
      assert.equal(record(result, 'tool result').path, 'out/report.md');
      return {
        content: 'summarized result',
        summarized: true,
        beforeTokens: 200,
        afterTokens: 40,
        sources: [{ path: 'out/report.md' }],
        injectionFlagged: true,
        injectionReasons: ['prompt-like tool output'],
      };
    },
  };
  const loopGuard: LoopGuard = {
    observe(call, ok) {
      assert.equal(call.name, 'WriteReport');
      assert.deepEqual(call.args, { path: 'out/report.md' });
      assert.equal(ok, true);
      return { shouldBreak: true, reason: 'repeated tool path', repeatCount: 2, consecutiveFailures: 0 };
    },
  };
  const hooks: HookEngine = {
    async run(event, payload) {
      if (event === 'post_tool') postHookPayloads.push(payload);
      return null;
    },
    blocked: () => false,
  };
  const harness = createHarness({
    tool,
    retryPolicy,
    contextManager,
    loopGuard,
    hooks,
    signal: controller.signal,
    autoApprove: true,
    hasApprovals: true,
  });

  const result = await harness.execute(makeCall('WriteReport', { path: 'out/report.md' }), {
    approvals: {
      request: () => {
        throw new Error('auto-approved tool should not request an approval');
      },
    },
  });

  assert.deepEqual(result, { didMutate: true, stopForLoopGuard: true, breakToolLoop: true });
  assert.deepEqual(harness.todoFinishes, ['done']);
  assert.equal(harness.messages.at(-2)?.content, 'summarized result');
  assert.match(String(harness.messages.at(-1)?.content), /循环护栏已停止当前路径/);
  assert.ok(harness.events.some((event) => event.type === 'tool_retry' && event.payload.attempts === 2));
  assert.ok(harness.events.some((event) => event.type === 'file_written' && event.payload.path === 'out/report.md'));
  assert.ok(harness.events.some((event) => event.type === 'tool_result_summary' && event.payload.beforeTokens === 200));
  assert.ok(harness.events.some((event) => event.type === 'untrusted_content_flagged'));
  assert.ok(harness.events.some((event) => event.type === 'loop_guard_break' && event.payload.reason === 'repeated tool path'));
  assert.ok(harness.audits.some((event) => event.kind === 'tool.auto_approved'));
  assert.ok(harness.audits.some((event) => event.kind === 'tool.execute' && event.extra?.ok === true));
  assert.deepEqual(record(postHookPayloads[0], 'post hook payload').result, { ok: true, path: 'out/report.md', body: 'done' });
});

test('executeToolCall turns thrown tool errors into failed results and stops on budget', async () => {
  const tool: AgentTool = {
    name: 'FetchReport',
    risk: 'safe',
    parameters: { type: 'object', properties: {} },
    handler: () => {
      throw new Error('upstream offline');
    },
  };
  let loopGuardRuns = 0;
  const budgetDecision = { shouldAbort: true, reason: 'token budget exhausted' };
  const harness = createHarness({
    tool,
    budgetGuard: { check: () => budgetDecision },
    loopGuard: {
      observe: () => {
        loopGuardRuns += 1;
        return {};
      },
    },
  });

  const result = await harness.execute(makeCall('FetchReport', {}));

  assert.deepEqual(result, { didMutate: false, stopForBudget: true, breakToolLoop: true });
  assert.equal(loopGuardRuns, 0);
  assert.deepEqual(harness.todoFinishes, ['failed']);
  assert.deepEqual(harness.stoppedBudgets, [budgetDecision]);
  assert.ok(harness.events.some((event) => event.type === 'tool_result' && event.payload.status === 'failed'));
  assert.match(String(harness.messages.at(-1)?.content), /upstream offline/);
});

test('executeToolCall treats non-Error thrown values as failed tool results', async () => {
  const tool: AgentTool = {
    name: 'FlakyTool',
    risk: 'safe',
    parameters: { type: 'object', properties: {} },
    handler: () => {
      throw 'string failure';
    },
  };
  const observed: Array<{ ok: boolean }> = [];
  const harness = createHarness({
    tool,
    loopGuard: {
      observe: (_call, ok) => {
        observed.push({ ok });
        return {};
      },
    },
  });

  const result = await harness.execute(makeCall('FlakyTool', {}));

  assert.deepEqual(result, { didMutate: false });
  assert.deepEqual(harness.todoFinishes, ['failed']);
  assert.deepEqual(observed, [{ ok: false }]);
  assert.equal(harness.events.some((event) => (
    event.type === 'tool_result'
    && event.payload.name === 'FlakyTool'
    && event.payload.status === 'failed'
  )), true);
  assert.match(String(harness.messages.at(-1)?.content), /string failure/);
});
