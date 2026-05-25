import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKimiApiChatPrompt,
  buildKimiApiPlanPrompt,
  resolveKimiApiConfig,
  runKimiApiPlan,
} from '../src/kimi/api-runner.js';

test('buildKimiApiPlanPrompt constrains API plan output', () => {
  const prompt = buildKimiApiPlanPrompt({
    mode: 'code',
    summary: '合同草稿包含 renewal date。',
    prompt: '生成整理计划',
    memory: '偏好：先列风险。',
  });

  assert.match(prompt, /工作区记忆/);
  assert.match(prompt, /只基于下面摘要回答/);
  assert.match(prompt, /不要修改文件/);
  assert.match(prompt, /不要使用工具/);
  assert.match(prompt, /模式：code/);
  assert.match(prompt, /renewal date/);
  assert.match(prompt, /生成整理计划/);
});

test('buildKimiApiChatPrompt is conversational (no forced file-planning)', () => {
  const prompt = buildKimiApiChatPrompt({
    summary: '已上传 invoice.pdf。',
    prompt: '这个文件能做什么？',
  });

  assert.match(prompt, /智能助手/);
  assert.match(prompt, /自然的中文/);
  // It must NOT push every turn into a file-operation plan.
  assert.match(prompt, /不要生成/);
  assert.match(prompt, /invoice\.pdf/);
  assert.match(prompt, /这个文件能做什么/);
});

test('resolveKimiApiConfig reads Kimi and Moonshot env names without exposing keys', () => {
  const config = resolveKimiApiConfig({}, {
    MOONSHOT_API_KEY: 'secret-key',
    MOONSHOT_BASE_URL: 'https://example.test/v1/',
    KIMI_MODEL: 'kimi-test',
    KIMI_API_TIMEOUT_MS: '1234',
    KIMI_API_MAX_TOKENS: '321',
  });

  assert.equal(config.configured, true);
  assert.equal(config.apiKey, 'secret-key');
  assert.equal(config.baseUrl, 'https://example.test/v1');
  assert.equal(config.model, 'kimi-test');
  assert.equal(config.timeoutMs, 1234);
  assert.equal(config.maxTokens, 321);
});

test('resolveKimiApiConfig reads model provider from env/config', () => {
  const envConfig = resolveKimiApiConfig({}, {
    KCW_MODEL_PROVIDER: 'OPENAI',
    KIMI_API_KEY: 'secret-key',
    KIMI_MODEL: 'gpt-test',
  });
  assert.equal(envConfig.provider, 'openai');

  const explicitConfig = resolveKimiApiConfig({ kimiProvider: 'openai/local' }, {});
  assert.equal(explicitConfig.provider, 'openai/local');
});

test('runKimiApiPlan posts OpenAI-compatible chat completions', async () => {
  let captured;
  const result = await runKimiApiPlan({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.test/v1',
    model: 'kimi-test',
    prompt: '生成计划',
    summary: '本地摘要',
    mode: 'cowork',
    timeoutMs: 5000,
    maxTokens: 100,
    fetchImpl: async (url, options) => {
      captured = {
        url,
        headers: options.headers,
        body: JSON.parse(options.body),
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: 'API 计划输出',
                },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          };
        },
      };
    },
  });

  assert.equal(captured.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer test-key');
  assert.equal(captured.body.model, 'kimi-test');
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.max_tokens, 100);
  assert.match(captured.body.messages[0].content, /本地摘要/);
  assert.equal(result.provider, 'kimi-api');
  assert.equal(result.model, 'kimi-test');
  assert.equal(result.text, 'API 计划输出');
  assert.equal(result.usage.total_tokens, 7);
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
