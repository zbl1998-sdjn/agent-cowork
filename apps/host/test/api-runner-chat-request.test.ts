import assert from 'node:assert/strict';
import test from 'node:test';
import { runKimiApiChat } from '../src/kimi/api-runner.js';

type ChatRequestBody = {
  model?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  messages?: Array<{ role?: unknown; content?: unknown }>;
};
type CapturedChatRequest = {
  url?: string;
  headers?: Record<string, string>;
  body?: ChatRequestBody;
};

test('runKimiApiChat posts system and user messages and extracts multipart text output', async () => {
  const captured: CapturedChatRequest = {};
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    captured.url = url;
    captured.headers = init.headers as Record<string, string>;
    captured.body = JSON.parse(String(init.body)) as ChatRequestBody;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{
            message: {
              content: ['第一段', { text: '第二段' }, { ignored: true }],
            },
          }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        };
      },
    };
  };

  const result = await runKimiApiChat({
    apiKey: 'test-key-chat',
    baseUrl: 'https://api.example.test/v1/',
    model: 'kimi-chat-test',
    provider: 'KIMI-API',
    prompt: '直接回答',
    summary: '当前摘要',
    memory: '长期记忆',
    systemMessage: '系统消息',
    timeoutMs: 5000,
    maxTokens: 77,
    userAgent: 'AgentCowork-Test',
    temperature: 0.7,
    fetchImpl,
  });

  assert.equal(captured.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(captured.headers?.authorization, 'Bearer test-key-chat');
  assert.equal(captured.headers?.accept, 'application/json');
  assert.equal(captured.headers?.['user-agent'], 'AgentCowork-Test');
  assert.equal(captured.body?.model, 'kimi-chat-test');
  assert.equal(captured.body?.stream, false);
  assert.equal(captured.body?.max_tokens, 77);
  assert.equal(captured.body?.temperature, 0.7);
  assert.equal(captured.body?.messages?.[0]?.role, 'system');
  assert.equal(captured.body?.messages?.[0]?.content, '系统消息');
  assert.equal(captured.body?.messages?.[1]?.role, 'user');
  assert.match(String(captured.body?.messages?.[1]?.content), /当前摘要/);
  assert.match(String(captured.body?.messages?.[1]?.content), /长期记忆/);
  assert.equal(result.provider, 'kimi-api');
  assert.equal(result.model, 'kimi-chat-test');
  assert.equal(result.mode, 'chat');
  assert.equal(result.text, '第一段\n第二段');
  const usage = result.usage as { total_tokens?: unknown } | null | undefined;
  assert.equal(usage?.total_tokens, 9);
});

test('runKimiApiChat rejects empty successful responses and abort-shaped failures', async () => {
  await assert.rejects(
    () => runKimiApiChat({
      apiKey: 'test-key-chat',
      prompt: 'empty',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: [{ ignored: true }] } }] };
        },
      }),
    }),
    /empty output/,
  );

  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  await assert.rejects(
    () => runKimiApiChat({
      apiKey: 'test-key-chat',
      prompt: 'abort',
      timeoutMs: 5000,
      fetchImpl: async () => {
        throw abortError;
      },
    }),
    /timed out after 5000ms/,
  );
});
