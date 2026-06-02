import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveKimiApiConfig } from '../src/kimi/api-runner.js';

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

  assert.equal(config.provider, 'claude');
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
