import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpointer } from '../src/runtime/run-checkpoint.js';
import { runAgentChat } from '../src/kimi/agent-runner.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-checkpoint-'));
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

  messages[0].content = 'mutated';
  usage.total_tokens = 99;
  approvedTools.add('Delete');

  const loaded = checkpointer.load('run_checkpoint_1');
  assert.equal(file, path.join(root, 'checkpoints', 'run_checkpoint_1.json'));
  assert.equal(loaded.version, 1);
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

test('runAgentChat checkpoints messages, usage, approvals and todos after loop progress', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const checkpointer = new RunCheckpointer({
    root: runStoreRoot,
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  });
  const tools = [{
    name: 'Echo',
    risk: 'safe',
    mutating: false,
    description: 'Echoes input',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    handler: async ({ value }) => ({ ok: true, value }),
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
  const events = [];

  const out = await runAgentChat({
    prompt: 'echo',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    tools,
    modelCall,
    runId: 'run_checkpoint_agent',
    runStoreRoot,
    checkpointer,
    emit: (type, payload) => events.push({ type, payload }),
  });

  const loaded = checkpointer.load('run_checkpoint_agent');
  assert.equal(out.text, 'done');
  assert.equal(loaded.runId, 'run_checkpoint_agent');
  assert.equal(loaded.phase, 'completed');
  assert.equal(loaded.step, 2);
  assert.deepEqual(loaded.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  assert.deepEqual(loaded.approvedTools, []);
  assert.ok(loaded.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'echo_1'));
  assert.deepEqual(loaded.messages.at(-1), { role: 'assistant', content: 'done' });
  assert.ok(loaded.todos.some((todo) => todo.id === 'tool-1-Echo' && todo.status === 'done'));
  assert.ok(events.some((event) => event.type === 'run_checkpoint_saved' && event.payload.phase === 'completed'));
});
