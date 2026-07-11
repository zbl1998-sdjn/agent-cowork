import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { streamChat } from '../src/kimi/chat-stream.js';
import { closeTestServer } from './helpers/close-server.js';
import type { HostServer, ServerConfig } from '../src/server.js';
import type { RequestContext } from '../src/http/middleware/common.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-stream-'));
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

class CapturingStreamResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;

  writeHead(statusCode: number, headers?: Record<string, string>): void {
    this.statusCode = statusCode;
    this.headers = headers || {};
  }

  write(chunk?: string | Buffer): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''));
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.write(chunk);
    this.ended = true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

function eventPayload(streamText: string, event: string): Record<string, unknown> {
  const marker = `event: ${event}\n`;
  const index = streamText.indexOf(marker);
  assert.ok(index >= 0, `missing ${event} SSE event`);
  const dataLine = streamText.slice(index + marker.length).split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, `${event} SSE event should include data`);
  return recordValue(JSON.parse(dataLine.slice('data: '.length)), `${event} payload`);
}

function streamContext(): RequestContext {
  return { tenantId: 'tenant_stream', userId: 'user_stream', traceId: 'trace_stream' };
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

test('POST /api/kimi/chat/stream emits start/token/done SSE frames and records a run', async () => {
  const fakeStream: NonNullable<ServerConfig['kimiChatStreamRunner']> = async ({ prompt, onToken } = {}) => {
    assert.match(String(prompt), /你好/);
    if (typeof onToken !== 'function') {
      throw new Error('stream test requires onToken callback');
    }
    for (const t of ['你', '好', '世界']) onToken(t);
    return { ok: true, provider: 'kimi-api', model: 'fake-model', mode: 'chat', text: '你好世界', durationMs: 0 };
  };
  const server = createServer({
    trustedRoot: tempRoot(),
    enableScheduler: false,
    kimiChatRunner: async () => ({ ok: true, provider: 'kimi-api', model: 'fake-model', mode: 'chat', text: 'x', durationMs: 0 }), // flips kimiApiEnabled on
    kimiChatStreamRunner: fakeStream,
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '你好', model: 'fake-model' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: token/);
    assert.equal((text.match(/event: token/g) || []).length, 3, 'one token frame per delta');
    assert.match(text, /event: done/);
    assert.match(text, /你好世界/);

    const indexBody = recordValue(await (await fetch(`${base}/api/runs/index`)).json(), 'runs index body');
    const runs = recordArray(indexBody.runs, 'runs index records');
    assert.ok(runs.some((run) => run.type === 'kimi-chat'));
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/kimi/chat/stream returns a truthful local-first 503 when no model is configured', async () => {
  const server = createServer({ trustedRoot: tempRoot(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/kimi/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }),
    });
    assert.equal(res.status, 503);
    const body = recordValue(await res.json(), 'error response body');
    assert.match(String(body.error), /请配置 Ollama\/LM Studio/);
    assert.match(String(body.error), /当前 Internal Beta 不允许公网云模型直接出站/);
    assert.doesNotMatch(String(body.error), /联网并配置 KIMI_API_KEY/);
  } finally {
    await closeTestServer(server);
  }
});

test('streamChat emits cancelled when the cancellation signal aborts after partial output', async () => {
  const trustedRoot = tempRoot();
  const runStoreRoot = path.join(trustedRoot, 'runs');
  const response = new CapturingStreamResponse();
  const controller = new AbortController();
  const doneRuns: string[] = [];
  const cancellationContexts: unknown[] = [];

  await streamChat({
    response,
    requestContext: streamContext(),
    body: { prompt: 'cancel me', summary: 'context' },
    kimiConfig: { provider: 'KIMI-API', model: 'moonshot-v1-8k', temperature: 0 },
    trustedRoot,
    runStoreRoot,
    runsIndex: { upsert: () => undefined },
    cancellation: {
      register(_runId, context?: unknown) {
        cancellationContexts.push(context);
        return controller;
      },
      done(runId, context?: unknown) {
        doneRuns.push(runId);
        cancellationContexts.push(context);
      },
    },
    streamRunner: ({ prompt, model, provider, signal, onToken, onReasoning }) => {
      assert.equal(prompt, 'cancel me');
      assert.equal(model, 'moonshot-v1-8k');
      assert.equal(provider, 'kimi-api');
      assert.equal(signal, controller.signal);
      onReasoning('thinking');
      onToken('partial');
      controller.abort();
      return { text: 'partial', model, usage: { total_tokens: 3 } };
    },
  });

  const text = response.text();
  const start = eventPayload(text, 'start');
  const cancelled = eventPayload(text, 'cancelled');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] || '', /text\/event-stream/);
  assert.equal(eventPayload(text, 'reasoning').delta, 'thinking');
  assert.equal(eventPayload(text, 'token').delta, 'partial');
  assert.equal(cancelled.runId, start.runId);
  assert.equal(cancelled.text, 'partial');
  assert.equal(doneRuns[0], start.runId);
  assert.deepEqual(cancellationContexts, [streamContext(), streamContext()]);
  assert.equal(response.ended, true);
});

test('streamChat records failures, emits safe errors, and isolates runs index failures', async () => {
  const trustedRoot = tempRoot();
  const response = new CapturingStreamResponse();
  const doneRuns: string[] = [];

  await streamChat({
    response,
    requestContext: streamContext(),
    body: { prompt: 'fail me' },
    kimiConfig: { provider: '', model: 'fake-model' },
    trustedRoot,
    runStoreRoot: path.join(trustedRoot, 'runs'),
    runsIndex: {
      upsert() {
        throw new Error('index down');
      },
    },
    cancellation: {
      register(runId) {
        doneRuns.push(`registered:${runId}`);
        return new AbortController();
      },
      done(runId) {
        doneRuns.push(`done:${runId}`);
      },
    },
    streamRunner: ({ systemMessage }) => {
      assert.match(systemMessage || '', /今天|工作目录|操作系统/);
      throw 'stream exploded';
    },
  });

  const text = response.text();
  const start = eventPayload(text, 'start');
  const error = eventPayload(text, 'error');
  assert.equal(error.error, 'stream exploded');
  assert.equal(doneRuns[0], `registered:${start.runId}`);
  assert.equal(doneRuns.at(-1), `done:${start.runId}`);
  assert.equal(response.ended, true);
});

test('streamChat treats thrown errors after an abort as cancellation', async () => {
  const trustedRoot = tempRoot();
  const response = new CapturingStreamResponse();
  const controller = new AbortController();

  await streamChat({
    response,
    requestContext: streamContext(),
    body: { prompt: 'abort then throw' },
    kimiConfig: { model: 'fake-model' },
    trustedRoot,
    runStoreRoot: path.join(trustedRoot, 'runs'),
    runsIndex: { upsert: () => undefined },
    cancellation: {
      register() {
        return controller;
      },
      done() {
        return undefined;
      },
    },
    streamRunner: ({ onToken }) => {
      onToken('before abort');
      controller.abort();
      throw new Error('transport closed');
    },
  });

  const text = response.text();
  assert.equal(eventPayload(text, 'cancelled').text, 'before abort');
  assert.equal(text.includes('event: error'), false);
  assert.equal(response.ended, true);
});
