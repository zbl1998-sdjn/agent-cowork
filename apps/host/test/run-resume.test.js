import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { RunCheckpointer } from '../src/runtime/run-checkpoint.js';
import { RunResumer } from '../src/runtime/run-resume.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-resume-'));
}

test('runAgentChat resumes from the latest checkpoint without replaying completed tool side effects', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, 'runs');
  const runId = 'run_resume_1';
  const effectPath = path.join(root, 'effect.txt');
  const checkpointer = new RunCheckpointer({ root: runStoreRoot });
  let executions = 0;
  const tools = [{
    name: 'AppendOnce',
    risk: 'low',
    mutating: true,
    description: 'Appends one line',
    parameters: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
    handler: async ({ line }) => {
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
    runAgentChat({
      prompt: 'append',
      kimiConfig: { model: 'fake' },
      trustedRoot: root,
      tools,
      modelCall: crashingModelCall,
      runId,
      runStoreRoot,
      checkpointer,
    }),
    /simulated crash/,
  );
  assert.equal(executions, 1);

  const resumeState = new RunResumer({ root: runStoreRoot }).load(runId);
  assert.equal(resumeState.phase, 'tool_result');
  assert.ok(resumeState.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'append_1'));

  let resumedMessages = [];
  const out = await runAgentChat({
    prompt: 'append',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    tools,
    runId,
    runStoreRoot,
    checkpointer,
    resumeState,
    modelCall: async ({ messages }) => {
      resumedMessages = messages;
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
  assert.ok(resumedMessages.some((message) => message.role === 'tool' && message.tool_call_id === 'append_1'));
});
