import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/engine/agent-runner.js';
import { RunCheckpointer } from '../src/runtime/run-checkpoint.js';
import { RunResumer, resumeStateFromCheckpoint } from '../src/runtime/run-resume.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { ChatMessage, ResumeState as AgentResumeState } from '../src/engine/agent/tool-loop-types.js';
import type { AgentTool, ToolArgs } from '../src/engine/agent/tool-call-executor.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-resume-'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasToolMessage(messages: unknown[], toolCallId: string): boolean {
  return messages.some((message) => (
    isRecord(message)
    && message.role === 'tool'
    && message.tool_call_id === toolCallId
  ));
}

test('runAgentChat resumes from the latest checkpoint without replaying completed tool side effects', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const runId = 'run_resume_1';
  const effectPath = path.join(root, 'effect.txt');
  const checkpointer = new RunCheckpointer({ root: runStoreRoot });
  const approvals = { request: () => ({ id: 'append_approval', promise: Promise.resolve('once') }) };
  let executions = 0;
  const tools: AgentTool[] = [{
    name: 'AppendOnce',
    risk: 'low',
    mutating: true,
    description: 'Appends one line',
    parameters: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
    handler: async (args: ToolArgs = {}) => {
      const line = String(args.line || '');
      executions += 1;
      fs.appendFileSync(effectPath, `${line}\n`, 'utf8');
      return { ok: true, path: effectPath, line };
    },
  }];
  let firstCalls = 0;
  const crashingModelCall = async () => {
    firstCalls += 1;
    if (firstCalls === 1) {
      return {
        content: '',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        tool_calls: [{ id: 'append_1', function: { name: 'AppendOnce', arguments: JSON.stringify({ line: 'hello' }) } }],
      };
    }
    throw new Error('simulated crash after checkpoint');
  };

  await assert.rejects(
    () => runAgentChat({
      prompt: 'append',
      kimiConfig: TEST_LOCAL_MODEL_CONFIG,
      trustedRoot: root,
      tools,
      modelCall: crashingModelCall,
      approvals,
      runId,
      runStoreRoot,
      checkpointer,
    }),
    /simulated crash/,
  );
  assert.equal(executions, 1);

  const resumeState = new RunResumer({ root: runStoreRoot }).load(runId);
  assert.ok(resumeState, 'resume state should be loadable');
  assert.equal(resumeState.phase, 'tool_result');
  assert.ok(hasToolMessage(resumeState.messages, 'append_1'));

  const agentResumeState: AgentResumeState = {
    usage: resumeState.usage,
    messages: resumeState.messages.filter(isRecord) as ChatMessage[],
    approvedTools: resumeState.approvedTools,
    todos: resumeState.todos,
  };
  let resumedMessages: ChatMessage[] = [];
  const out = await runAgentChat({
    prompt: 'append',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    runId,
    runStoreRoot,
    checkpointer,
    resumeState: agentResumeState,
    modelCall: async (args) => {
      resumedMessages = Array.isArray(args.messages) ? args.messages as ChatMessage[] : [];
      return {
        content: 'resumed done',
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      };
    },
  });

  assert.equal(out.text, 'resumed done');
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(executions, 1, 'completed tool handler must not run again during resume');
  assert.equal(fs.readFileSync(effectPath, 'utf8'), 'hello\n');
  assert.ok(hasToolMessage(resumedMessages, 'append_1'));
});

test('resumeStateFromCheckpoint normalizes malformed legacy checkpoint counters', () => {
  const state = resumeStateFromCheckpoint({
    runId: 'run_legacy',
    step: 'not-a-number',
    phase: '',
    messages: 'bad',
    usage: {
      prompt_tokens: 'bad',
      completion_tokens: Infinity,
      total_tokens: 5,
    },
    approvedTools: ['Write', '', null, ' Shell '],
    todos: [{ id: 'todo-1' }],
    metadata: ['bad'],
  });

  assert.equal(state.step, 0);
  assert.equal(state.phase, 'unknown');
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 5,
  });
  assert.deepEqual(state.approvedTools, ['Write', 'Shell']);
  assert.deepEqual(state.todos, [{ id: 'todo-1' }]);
  assert.deepEqual(state.metadata, {});
});
