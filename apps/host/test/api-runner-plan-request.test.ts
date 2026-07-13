import assert from 'node:assert/strict';
import test from 'node:test';
import { runKimiApiPlan } from '../src/engine/api-runner.js';
import {
  kimiTextResultSchema,
  successfulPlanFetch,
  type CapturedKimiRequestSlot,
} from './helpers/api-runner.js';
import { makeTestWorkspace } from './test-fixtures.js';

const LOCAL_EGRESS = {
  trustedRoot: makeTestWorkspace('api-runner-plan'),
  securityMode: 'local_strict',
  provider: 'openai/local',
  baseUrl: 'http://127.0.0.1:11434/v1',
} as const;

test('runKimiApiPlan posts OpenAI-compatible chat completions', async () => {
  const captured: CapturedKimiRequestSlot = {};
  const result = kimiTextResultSchema.parse(await runKimiApiPlan({
    apiKey: 'test-key-plan',
    ...LOCAL_EGRESS,
    model: 'kimi-test',
    prompt: '生成计划',
    summary: '本地摘要',
    mode: 'cowork',
    timeoutMs: 5000,
    maxTokens: 100,
    fetchImpl: successfulPlanFetch(captured),
  }));

  assert.ok(captured.request, 'fetch request should be captured');
  assert.equal(captured.request.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(captured.request.authorization, 'Bearer test-key-plan');
  assert.equal(captured.request.body.model, 'kimi-test');
  assert.equal(captured.request.body.stream, false);
  assert.equal(captured.request.body.max_tokens, 100);
  assert.match(captured.request.body.messages[0]?.content ?? '', /本地摘要/);
  assert.equal(result.provider, 'openai/local');
  assert.equal(result.model, 'kimi-test');
  assert.equal(result.text, 'API 计划输出');
  assert.equal(result.usage?.total_tokens, 7);
});

test('runKimiApiPlan rejects missing API key before network calls', async () => {
  await assert.rejects(
    () => runKimiApiPlan({
      prompt: '生成计划',
      summary: '摘要',
      fetchImpl: async () => {
        throw new Error('should not call network');
      },
    }),
    /本地文件功能仍可离线使用/,
  );
});
