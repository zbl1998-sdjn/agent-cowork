import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import type { KimiTextResult } from '../src/kimi/api-runner.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';
import type { AgentTool } from '../src/kimi/agent/tool-loop-support.js';
import { createServer } from '../src/server.js';
import { bind, close, readableBody, recordValue, stringField, tempRoot } from './helpers/host-http.js';

const noop: AgentTool = {
  name: 'noop',
  risk: 'safe',
  mutating: false,
  description: 'noop',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ ok: true }),
};

function tmp(): string {
  return tempRoot('kcw-cu-');
}

function booleanField(source: Record<string, unknown>, key: string, label = key): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} should be a boolean`);
  }
  return value;
}

async function okKimiChat(): Promise<KimiTextResult> {
  return { ok: true, provider: 'test', model: 'test', mode: 'chat', text: 'ok', durationMs: 0 };
}

function abortError(): Error {
  const err = new Error('model call aborted');
  err.name = 'AbortError';
  return err;
}

async function readStartFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ all: string; runId: string | null }> {
  const dec = new TextDecoder();
  let all = '';
  let runId: string | null = null;
  while (!runId) {
    const { value, done } = await reader.read();
    if (done) break;
    all += dec.decode(value, { stream: true });
    const match = /event: start\r?\ndata: (\{.*\})/.exec(all);
    if (match) {
      const frame = match[1];
      assert.ok(frame, 'start frame should include JSON payload');
      runId = stringField(recordValue(JSON.parse(frame), 'start frame'), 'runId');
    }
  }
  return { all, runId };
}

async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>, all = ''): Promise<string> {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    all += dec.decode(value, { stream: true });
  }
  return all;
}

async function waitForFileContent(file: string, expected: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', expected);
}

test('runAgentChat accumulates token usage across model calls', async () => {
  const root = tmp();
  let n = 0;
  const modelCall: ModelCall = async () => {
    n += 1;
    if (n === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'noop', arguments: '{}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
    return { content: '完成。', usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } };
  };

  const out = await runAgentChat({
    prompt: 'x',
    kimiConfig: {},
    trustedRoot: root,
    tools: [noop],
    modelCall,
    runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(out.usage.prompt_tokens, 18);
  assert.equal(out.usage.completion_tokens, 7);
  assert.equal(out.usage.total_tokens, 25);
  assert.equal(out.cancelled, false);
});

test('runAgentChat stops between steps when the abort signal fires', async () => {
  const root = tmp();
  const ac = new AbortController();
  let calls = 0;
  const modelCall: ModelCall = async () => {
    calls += 1;
    ac.abort(); // Simulates the user pressing stop during the first step.
    return { content: '', tool_calls: [{ id: `c${calls}`, function: { name: 'noop', arguments: '{}' } }] };
  };

  const out = await runAgentChat({
    prompt: 'x',
    kimiConfig: {},
    trustedRoot: root,
    tools: [noop],
    modelCall,
    signal: ac.signal,
    maxSteps: 6,
    runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(out.cancelled, true);
  assert.equal(calls, 1, 'stopped before the next model call');
});

test('E2E /api/agent/chat/stream: POST /api/runs/:id/cancel stops the run with a cancelled frame + usage in done', async () => {
  const root = tmp();
  let n = 0;
  const agentModelCall: ModelCall = async () => {
    n += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { content: '', tool_calls: [{ id: `c${n}`, function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) } }] };
  };
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: okKimiChat, agentModelCall });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'loop', autoApprove: true }),
    });
    const reader = readableBody(res, 'agent stream response').getReader();
    const start = await readStartFrame(reader);
    assert.ok(start.runId, 'start frame carried runId');
    const cx = await fetch(`${base}/api/runs/${start.runId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const cancelBody = recordValue(await cx.json(), 'cancel response');
    assert.equal(booleanField(cancelBody, 'cancelled'), true);
    const all = await readRest(reader, start.all);
    assert.match(all, /event: cancelled/);
  } finally {
    await close(server);
  }
});

test('E2E /api/agent/chat/stream: cancelled run resumes from checkpoint without replaying writes', async () => {
  const root = tmp();
  const target = path.join(root, 'cancel-resume.txt');
  let mode: 'first' | 'resume' = 'first';
  let firstCalls = 0;
  let resumedSawToolResult = false;
  const agentModelCall: ModelCall = async ({ messages, signal }) => {
    if (mode === 'resume') {
      resumedSawToolResult = Array.isArray(messages) && messages.some((message) => {
        const record = message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, unknown> : {};
        return record.role === 'tool' && record.tool_call_id === 'write_1';
      });
      return resumedSawToolResult
        ? { content: '续跑完成。' }
        : { content: '', tool_calls: [{ id: 'replay_write', function: { name: 'Write', arguments: JSON.stringify({ path: 'cancel-resume.txt', content: 'replayed' }) } }] };
    }
    firstCalls += 1;
    if (firstCalls === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'write_1', function: { name: 'Write', arguments: JSON.stringify({ path: 'cancel-resume.txt', content: 'first' }) } }],
      };
    }
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => resolve({ content: 'unexpected completion' }), 1000);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: okKimiChat, agentModelCall });
  const base = await bind(server);
  try {
    const first = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'write then wait', autoApprove: true }),
    });
    const firstReader = readableBody(first, 'first agent stream response').getReader();
    const start = await readStartFrame(firstReader);
    assert.ok(start.runId, 'start frame carried runId');
    await waitForFileContent(target, 'first');
    const cx = await fetch(`${base}/api/runs/${start.runId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(booleanField(recordValue(await cx.json(), 'cancel response'), 'cancelled'), true);
    const firstSse = await readRest(firstReader, start.all);
    assert.match(firstSse, /event: cancelled/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'first');

    mode = 'resume';
    const resumed = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resumeRunId: start.runId, autoApprove: true }),
    });
    const resumedSse = await readRest(readableBody(resumed, 'resumed agent stream response').getReader());
    assert.match(resumedSse, /event: start\r?\ndata: \{"runId":"[^"]+","resumed":true\}/);
    assert.match(resumedSse, /event: done/);
    assert.match(resumedSse, /续跑完成。/);
    assert.equal(resumedSawToolResult, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  } finally {
    await close(server);
  }
});
