import assert from 'node:assert/strict';
import test from 'node:test';
import { runKimiApiChatStream } from '../src/kimi/api-runner.js';
import { makeTestWorkspace } from './test-fixtures.js';

const LOCAL_EGRESS = {
  trustedRoot: makeTestWorkspace('api-runner-stream'),
  securityMode: 'local_strict',
  provider: 'openai/local',
  baseUrl: 'http://127.0.0.1:11434/v1',
} as const;

type StreamReader = { read(): Promise<{ value?: Uint8Array; done?: boolean }> };
type RequestBody = {
  model?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  messages?: Array<{ role?: unknown; content?: unknown }>;
};
type CapturedStreamRequest = {
  url?: string;
  headers?: Record<string, string>;
  body?: RequestBody;
};

function streamReader(chunks: string[]): StreamReader {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  return {
    async read() {
      if (index >= encoded.length) return { done: true };
      const value = encoded[index];
      index += 1;
      assert.ok(value);
      return { value, done: false };
    },
  };
}

test('runKimiApiChatStream posts a streaming chat request and emits token callbacks', async () => {
  const captured: CapturedStreamRequest = {};
  const tokens: string[] = [];
  const reasoning: string[] = [];
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    captured.url = url;
    captured.headers = init.headers as Record<string, string>;
    captured.body = JSON.parse(String(init.body)) as RequestBody;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => streamReader([
          ': keepalive\n',
          'data: {"choices":[{"delta":{"reasoning_content":"先想","content":"你',
          '好"}}]}\n',
          'data: not-json\n',
          'data: {"choices":[{"delta":{"content":"呀"}}]}\n',
          'data: [DONE]\n',
        ]),
      },
    };
  };

  const result = await runKimiApiChatStream({
    apiKey: 'test-key-stream',
    ...LOCAL_EGRESS,
    model: 'kimi-stream-test',
    prompt: '打招呼',
    summary: '当前摘要',
    memory: '长期记忆',
    systemMessage: '系统要求',
    timeoutMs: 5000,
    maxTokens: 22,
    userAgent: 'AgentCowork-Test',
    temperature: 0.3,
    fetchImpl,
    onToken: (delta) => tokens.push(delta),
    onReasoning: (delta) => reasoning.push(delta),
  });

  assert.equal(captured.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(captured.headers?.authorization, 'Bearer test-key-stream');
  assert.equal(captured.headers?.accept, 'text/event-stream');
  assert.equal(captured.headers?.['user-agent'], 'AgentCowork-Test');
  assert.equal(captured.body?.model, 'kimi-stream-test');
  assert.equal(captured.body?.stream, true);
  assert.equal(captured.body?.max_tokens, 22);
  assert.equal(captured.body?.temperature, 0.3);
  assert.equal(captured.body?.messages?.[0]?.role, 'system');
  assert.equal(captured.body?.messages?.[0]?.content, '系统要求');
  assert.equal(captured.body?.messages?.[1]?.role, 'user');
  assert.match(String(captured.body?.messages?.[1]?.content), /当前摘要/);
  assert.match(String(captured.body?.messages?.[1]?.content), /长期记忆/);
  assert.deepEqual(reasoning, ['先想']);
  assert.deepEqual(tokens, ['你好', '呀']);
  assert.equal(result.provider, 'openai/local');
  assert.equal(result.model, 'kimi-stream-test');
  assert.equal(result.mode, 'chat');
  assert.equal(result.text, '你好呀');
});

test('runKimiApiChatStream keeps the final SSE data line when the stream closes without a trailing newline', async () => {
  const result = await runKimiApiChatStream({
    apiKey: 'test-key-stream',
    ...LOCAL_EGRESS,
    prompt: '末尾 token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => streamReader([
          'data: {"choices":[{"delta":{"content":"最后一段"}}]}',
        ]),
      },
    }),
  });

  assert.equal(result.text, '最后一段');
});

test('runKimiApiChatStream fails closed before unsupported or failed streams are consumed', async () => {
  await assert.rejects(
    () => runKimiApiChatStream({
      prompt: '缺少 key',
      fetchImpl: async () => {
        throw new Error('network must not be called');
      },
    }),
    /本地文件功能仍可离线使用/,
  );

  await assert.rejects(
    () => runKimiApiChatStream({
      apiKey: 'test-key-stream',
      ...LOCAL_EGRESS,
      prompt: 'HTTP error',
      fetchImpl: async () => ({ ok: false, status: 429, body: null }),
    }),
    /status 429/,
  );

  await assert.rejects(
    () => runKimiApiChatStream({
      apiKey: 'test-key-stream',
      ...LOCAL_EGRESS,
      prompt: 'missing body',
      fetchImpl: async () => ({ ok: true, status: 200, body: null }),
    }),
    /streaming not supported/,
  );
});
