import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveKimiApiConfig } from '../src/engine/api-runner.js';

test('resolveKimiApiConfig reads Kimi and Moonshot env names without exposing keys', () => {
  const config = resolveKimiApiConfig({}, {
    MOONSHOT_API_KEY: 'test-key-primary',
    MOONSHOT_BASE_URL: 'https://example.test/v1/',
    KIMI_MODEL: 'kimi-test',
    KIMI_API_TIMEOUT_MS: '1234',
    KIMI_API_MAX_TOKENS: '321',
  });

  assert.equal(config.configured, true);
  assert.equal(config.apiKey, 'test-key-primary');
  assert.equal(config.baseUrl, 'https://example.test/v1');
  assert.equal(config.model, 'kimi-test');
  assert.equal(config.timeoutMs, 1234);
  assert.equal(config.maxTokens, 321);
});

test('resolveKimiApiConfig reads model provider from env/config', () => {
  const envConfig = resolveKimiApiConfig({}, {
    KCW_MODEL_PROVIDER: 'OPENAI',
    KIMI_API_KEY: 'test-key-env',
    KIMI_MODEL: 'gpt-test',
  });
  assert.equal(envConfig.provider, 'openai');

  const explicitConfig = resolveKimiApiConfig({ kimiProvider: 'openai/local' }, {});
  assert.equal(explicitConfig.provider, 'openai/local');
});

test('resolveKimiApiConfig reads opencode-style domestic provider defaults and env keys', () => {
  const config = resolveKimiApiConfig({}, {
    KCW_MODEL_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'test-key-deepseek',
  });

  assert.equal(config.provider, 'deepseek');
  assert.equal(config.configured, true);
  assert.equal(config.apiKey, 'test-key-deepseek');
  assert.equal(config.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.model, 'deepseek-v4-flash');
  assert.equal(config.fullModelId, 'deepseek/deepseek-v4-flash');
});

test('resolveKimiApiConfig parses provider_id/model_id when provider is omitted', () => {
  const config = resolveKimiApiConfig({}, {
    KIMI_MODEL: 'openai/local/qwen2.5-coder:7b',
  });

  assert.equal(config.provider, 'openai/local');
  assert.equal(config.model, 'qwen2.5-coder:7b');
  assert.equal(config.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(config.configured, true);
});

test('resolveKimiApiConfig carries host security mode from config or env', () => {
  const fromEnv = resolveKimiApiConfig({}, { SECURITY_MODE: 'local_strict' });
  assert.equal(fromEnv.securityMode, 'local_strict');

  const fromConfig = resolveKimiApiConfig({ securityMode: 'enterprise_hybrid' }, { SECURITY_MODE: 'local_strict' });
  assert.equal(fromConfig.securityMode, 'enterprise_local');
});

test('resolveKimiApiConfig reads Anthropic provider-specific env without Kimi defaults', () => {
  const config = resolveKimiApiConfig({}, {
    KCW_MODEL_PROVIDER: 'anthropic',
    KIMI_API_KEY: 'test-key-kimi-unused',
    KIMI_MODEL: 'kimi-model-should-not-cross',
    ANTHROPIC_API_KEY: 'test-key-anthropic',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.test/v1/',
    ANTHROPIC_MODEL: 'claude-test',
  });

  assert.equal(config.provider, 'anthropic');
  assert.equal(config.configured, true);
  assert.equal(config.apiKey, 'test-key-anthropic');
  assert.equal(config.baseUrl, 'https://api.anthropic.test/v1');
  assert.equal(config.model, 'claude-test');
});

test('resolveKimiApiConfig fails closed for Anthropic when no model env is configured', () => {
  const config = resolveKimiApiConfig({}, {
    KIMI_PROVIDER: 'claude',
    CLAUDE_API_KEY: 'test-key-claude',
  });

  assert.equal(config.provider, 'anthropic');
  assert.equal(config.configured, true);
  assert.equal(config.apiKey, 'test-key-claude');
  assert.equal(config.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(config.model, '');
});

test('resolveKimiApiConfig reads sanitized fallback model chain', () => {
  const fromEnv = resolveKimiApiConfig({}, {
    KIMI_API_KEY: 'test-key-primary',
    KCW_MODEL_FALLBACKS: JSON.stringify([
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'local-model' },
      { provider: 'OPENAI', apiKey: 'test-key-fallback', baseUrl: 'https://api.openai.test/v1', model: 'gpt-fallback', maxTokens: 99 },
    ]),
  });

  const firstFallback = fromEnv.fallbacks[0];
  const secondFallback = fromEnv.fallbacks[1];
  assert.ok(firstFallback);
  assert.ok(secondFallback);
  assert.equal(fromEnv.fallbacks.length, 2);
  assert.equal(firstFallback.provider, 'openai/local');
  assert.equal(firstFallback.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(firstFallback.apiKey, undefined);
  assert.equal(secondFallback.provider, 'openai');
  assert.equal(secondFallback.apiKey, 'test-key-fallback');
  assert.equal(secondFallback.maxTokens, 99);
});
