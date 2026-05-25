import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createLoopGuard } from '../src/kimi/agent/loop-guard.js';
import { createRetryPolicy } from '../src/kimi/agent/tool-retry.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tool-loop-resilience-'));
}

test('runAgentChat retries retryable tool failures before sending the tool result back to the model', async () => {
  const root = tmp();
  const delays = [];
  let toolAttempts = 0;
  const tools = [{
    name: 'FetchReport',
    risk: 'safe',
    mutating: false,
    description: 'Fetches a report',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      toolAttempts += 1;
      if (toolAttempts === 1) return { error: 'ETIMEDOUT: temporary network timeout' };
      return { ok: true, report: 'ready' };
    },
  }];
  const retryPolicy = createRetryPolicy({
    maxAttempts: 3,
    baseDelayMs: 5,
    sleep: async (delay) => { delays.push(delay); },
  });
  let calls = 0;
  let capturedToolMessage = null;
  const modelCall = async ({ messages }) => {
    calls += 1;
    if (calls === 1) {
      return { content: '', tool_calls: [{ id: 'fetch_1', function: { name: 'FetchReport', arguments: '{}' } }] };
    }
    capturedToolMessage = messages.at(-1);
    return { content: 'done' };
  };

  const out = await runAgentChat({
    prompt: 'fetch',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    tools,
    modelCall,
    retryPolicy,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(out.text, 'done');
  assert.equal(toolAttempts, 2);
  assert.deepEqual(delays, [5]);
  assert.match(capturedToolMessage.content, /"ok": true/);
  assert.doesNotMatch(capturedToolMessage.content, /ETIMEDOUT/);
});

test('runAgentChat stops repeated identical tool calls through LoopGuard before exhausting maxSteps', async () => {
  const root = tmp();
  const events = [];
  let toolExecutions = 0;
  const tools = [{
    name: 'Ping',
    risk: 'safe',
    mutating: false,
    description: 'Returns a ping response',
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
    handler: async () => {
      toolExecutions += 1;
      return { ok: true, value: 'pong' };
    },
  }];
  const loopGuard = createLoopGuard({ maxRepeats: 2, maxConsecutiveFailures: 3 });
  const modelCall = async ({ tools: modelTools }) => {
    if (modelTools && modelTools.length > 0) {
      return { content: '', tool_calls: [{ id: `ping_${Math.random()}`, function: { name: 'Ping', arguments: JSON.stringify({ target: 'same' }) } }] };
    }
    return { content: 'stopped by guard' };
  };

  const out = await runAgentChat({
    prompt: 'ping loop',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    tools,
    modelCall,
    loopGuard,
    maxSteps: 6,
    emit: (type, payload) => events.push({ type, payload }),
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(out.text, 'stopped by guard');
  assert.equal(toolExecutions, 2);
  assert.ok(events.some((event) => event.type === 'loop_guard_break' && /repeated/i.test(event.payload.reason)));
});
