import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpointer } from '../src/runtime/run-checkpoint.js';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createCheckpointRecorder } from '../src/kimi/agent/checkpoint-state.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { AgentTool, ToolArgs } from '../src/kimi/agent/tool-call-executor.js';

type EmittedEvent = {
  type: string;
  payload: Record<string, unknown>;
};

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-checkpoint-'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function lastItem<T>(items: T[]): T {
  const item = items.at(-1);
  assert.ok(item, 'expected a last item');
  return item;
}

test('RunCheckpointer saves and loads a complete cloned loop state', () => {
  const root = tempRoot();
  const checkpointer = new RunCheckpointer({
    root,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const messages = [{ role: 'user', content: '写一个计划' }];
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  const approvedTools = new Set(['Write', 'Shell']);

  const file = checkpointer.save({
    runId: 'run_checkpoint_1',
    step: 2,
    phase: 'tool_result',
    messages,
    usage,
    approvedTools,
    todos: [{ id: 'todo-1', text: '调用 Write', status: 'done' }],
    metadata: { traceId: 'trace_1' },
  });

  const firstMessage = messages[0];
  assert.ok(firstMessage, 'first message should exist');
  firstMessage.content = 'mutated';
  usage.total_tokens = 99;
  approvedTools.add('Delete');

  const loaded = checkpointer.load('run_checkpoint_1');
  assert.ok(loaded, 'checkpoint should be loadable');
  assert.equal(file, path.join(root, 'checkpoints', 'run_checkpoint_1.json'));
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.owner, { tenantId: 'tenant_local', userId: 'user_local' });
  assert.equal(loaded.runId, 'run_checkpoint_1');
  assert.equal(loaded.step, 2);
  assert.equal(loaded.phase, 'tool_result');
  assert.equal(loaded.updatedAt, '2026-05-25T00:00:00.000Z');
  assert.deepEqual(loaded.messages, [{ role: 'user', content: '写一个计划' }]);
  assert.deepEqual(loaded.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  assert.deepEqual(loaded.approvedTools, ['Shell', 'Write']);
  assert.deepEqual(loaded.todos, [{ id: 'todo-1', text: '调用 Write', status: 'done' }]);
  assert.deepEqual(loaded.metadata, { traceId: 'trace_1' });
});

test('RunCheckpointer rejects invalid run ids before writing', () => {
  const root = tempRoot();
  const checkpointer = new RunCheckpointer({ root });

  assert.throws(
    () => checkpointer.save({ runId: '../escape', step: 1, messages: [] }),
    /Invalid run id/,
  );
  assert.equal(fs.existsSync(path.join(root, '..', 'escape.json')), false);
});

test('RunCheckpointer refuses to overwrite incomplete or mismatched persisted state', () => {
  for (const scenario of [
    { name: 'incomplete', storedRunId: null },
    { name: 'mismatched', storedRunId: 'run_checkpoint_other' },
  ]) {
    const root = tempRoot();
    const runId = `run_checkpoint_${scenario.name}`;
    const file = path.join(root, 'checkpoints', `${runId}.json`);
    const persisted = scenario.storedRunId === null
      ? {}
      : {
        version: 1,
        runId: scenario.storedRunId,
        step: 0,
        phase: 'unknown',
        updatedAt: '2026-05-25T00:00:00.000Z',
        messages: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        approvedTools: [],
        todos: [],
        metadata: {},
      };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(persisted)}\n`, 'utf8');
    const before = fs.readFileSync(file);

    assert.throws(
      () => new RunCheckpointer({ root }).save({ runId, step: 1 }),
      /checkpoint.*corrupt|verified|runId/i,
    );
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

test('RunCheckpointer can replace a complete version 1 local checkpoint', () => {
  const root = tempRoot();
  const runId = 'run_checkpoint_legacy_v1';
  const file = path.join(root, 'checkpoints', `${runId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    runId,
    step: 0,
    phase: 'unknown',
    updatedAt: '2026-05-25T00:00:00.000Z',
    messages: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    approvedTools: [],
    todos: [],
    metadata: {},
  })}\n`, 'utf8');

  new RunCheckpointer({ root }).save({ runId, step: 2 });
  assert.equal(new RunCheckpointer({ root }).load(runId)?.version, 2);
});

test('createCheckpointRecorder mirrors todos, emits save events, and reports save failures', () => {
  const events: EmittedEvent[] = [];
  const saved: Record<string, unknown>[] = [];
  const sessionApproved = new Set<unknown>(['Write']);
  const initialTodos = [{ id: 'todo-1', text: 'old', status: 'pending' }];
  const recorder = createCheckpointRecorder({
    checkpointer: {
      save(input) {
        saved.push(input);
        return 'checkpoint-file';
      },
    },
    runId: 'run_recorder',
    usageTotals: { total_tokens: 7 },
    sessionApproved,
    steps: [{ tool: 'Write' }],
    context: { tenantId: 'tenant_a' },
    initialTodos,
    getFinalText: () => 'final text',
    emit: (type, payload) => events.push({ type, payload: isRecord(payload) ? payload : {} }),
  });

  initialTodos[0] = { id: 'todo-1', text: 'mutated', status: 'done' };
  recorder.emitTodo('todo_update', { id: 'todo-1', text: 'new', status: 'running' });
  recorder.emitTodo('todo_update', { id: 'todo-2', text: 'second', status: 'pending' });
  recorder.emitTodo('todo_update', { text: 'missing id' });
  recorder.emitTodo('progress', { text: 'visible' });
  assert.equal(recorder.save('after_tool', 3, [{ role: 'user', content: 'hi' }]), true);

  const checkpoint = saved[0];
  assert.ok(checkpoint, 'checkpoint payload should be captured');
  assert.equal(checkpoint.runId, 'run_recorder');
  assert.equal(checkpoint.step, 3);
  assert.equal(checkpoint.phase, 'after_tool');
  assert.deepEqual(checkpoint.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(checkpoint.usage, { total_tokens: 7 });
  assert.equal(checkpoint.approvedTools, sessionApproved);
  assert.deepEqual(checkpoint.todos, [
    { id: 'todo-1', text: 'new', status: 'running' },
    { id: 'todo-2', text: 'second', status: 'pending' },
  ]);
  assert.deepEqual(checkpoint.metadata, {
    context: { tenantId: 'tenant_a' },
    steps: [{ tool: 'Write' }],
    finalText: 'final text',
  });
  assert.ok(events.some((event) => event.type === 'run_checkpoint_saved' && event.payload.phase === 'after_tool'));

  const failingEvents: EmittedEvent[] = [];
  const failingRecorder = createCheckpointRecorder({
    checkpointer: { save: () => { throw new Error('disk full'); } },
    runId: 'run_failing',
    usageTotals: {},
    sessionApproved: new Set(),
    steps: [],
    getFinalText: () => '',
    emit: (type, payload) => failingEvents.push({ type, payload: isRecord(payload) ? payload : {} }),
  });
  assert.equal(failingRecorder.save('failed', 1, []), false);
  assert.deepEqual(failingEvents.at(-1), {
    type: 'run_checkpoint_error',
    payload: { runId: 'run_failing', step: 1, phase: 'failed', error: 'disk full' },
  });

  const disabledRecorder = createCheckpointRecorder({
    checkpointer: null,
    runId: 'run_disabled',
    usageTotals: {},
    sessionApproved: new Set(),
    steps: [],
    getFinalText: () => '',
    emit: () => undefined,
  });
  assert.equal(disabledRecorder.save('noop', 0, []), false);
});

test('runAgentChat checkpoints messages, usage, approvals and todos after loop progress', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const checkpointer = new RunCheckpointer({
    root: runStoreRoot,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const tools: AgentTool[] = [{
    name: 'Echo',
    risk: 'safe',
    mutating: false,
    description: 'Echoes input',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    handler: async (args: ToolArgs = {}) => ({ ok: true, value: args.value }),
  }];
  let calls = 0;
  const modelCall = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        tool_calls: [{ id: 'echo_1', function: { name: 'Echo', arguments: JSON.stringify({ value: 'hello' }) } }],
      };
    }
    return {
      content: 'done',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    };
  };
  const events: EmittedEvent[] = [];

  const out = await runAgentChat({
    prompt: 'echo',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    runId: 'run_checkpoint_agent',
    runStoreRoot,
    checkpointer,
    emit: (type, payload) => events.push({ type, payload: isRecord(payload) ? payload : {} }),
  });

  const loaded = checkpointer.load('run_checkpoint_agent');
  const checkpointErrors = events.filter((event) => event.type === 'run_checkpoint_error');
  assert.ok(loaded, `agent checkpoint should be loadable: ${JSON.stringify(checkpointErrors)}`);
  assert.equal(out.text, 'done');
  assert.equal(loaded.runId, 'run_checkpoint_agent');
  assert.equal(loaded.phase, 'completed');
  assert.equal(loaded.step, 2);
  assert.deepEqual(loaded.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  assert.deepEqual(loaded.approvedTools, []);
  assert.ok(loaded.messages.some((message) => isRecord(message) && message.role === 'tool' && message.tool_call_id === 'echo_1'));
  assert.deepEqual(lastItem(loaded.messages), { role: 'assistant', content: 'done' });
  assert.ok(loaded.todos.some((todo) => isRecord(todo) && todo.id === 'tool-1-Echo' && todo.status === 'done'));
  assert.ok(events.some((event) => event.type === 'run_checkpoint_saved' && event.payload.phase === 'completed'));
});
