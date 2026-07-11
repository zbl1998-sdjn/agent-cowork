import assert from 'node:assert/strict';
import test from 'node:test';
import { applySessionModelConfig, hasSessionModelAccess } from '../src/routes/session-model-config.js';

test('session model config validates, normalizes, and keeps fallback chains host-managed', () => {
  const fallback = [{ provider: 'kimi-api', model: 'safe-fallback', apiKey: 'test-fallback-key' }];
  const config = applySessionModelConfig(
    { provider: 'kimi-api', model: 'kimi-default', fallbacks: fallback },
    {
      prompt: '临时换模型',
      modelConfig: {
        provider: ' LOCAL-OPENAI ',
        baseUrl: 'HTTP://LOCALHOST:11434/v1///',
        model: ' gpt-local ',
        apiKey: ' test-session-key ',
        fallbacks: [{ provider: 'openai', apiKey: 'test-request-fallback-key' }],
      },
    },
  );

  assert.equal(config.provider, 'openai/local');
  assert.equal(config.baseUrl, 'http://localhost:11434/v1');
  assert.equal(config.model, 'gpt-local');
  assert.equal(config.apiKey, 'test-session-key');
  assert.deepEqual(config.fallbacks, fallback);
  assert.equal(hasSessionModelAccess({ modelConfig: { provider: ' OPENAI/LOCAL ' } }), true);
  assert.equal(hasSessionModelAccess({ modelConfig: { provider: ' OLLAMA ' } }), true);
});

test('session model config cannot disguise public or metadata endpoints as local providers', () => {
  assert.equal(hasSessionModelAccess({
    modelConfig: { provider: 'openai/local', baseUrl: 'https://models.example.com/v1' },
  }), false);
  assert.equal(hasSessionModelAccess({
    modelConfig: { provider: 'ollama', baseUrl: 'http://169.254.169.254/latest/meta-data' },
  }), false);
  assert.throws(
    () => applySessionModelConfig({}, {
      modelConfig: { provider: 'openai/local', baseUrl: 'file:///etc/passwd', model: 'probe' },
    }),
    /modelConfig\.baseUrl:.*http.*https/i,
  );
});

test('a request-supplied API key cannot grant an arbitrary session endpoint permission', () => {
  const body = {
    modelConfig: {
      provider: 'custom-openai-compatible',
      baseUrl: 'https://attacker-controlled.example/v1',
      model: 'probe',
      apiKey: 'dummy-session-key',
    },
  };
  assert.equal(hasSessionModelAccess(body), false);
  assert.throws(
    () => applySessionModelConfig(
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
      body,
    ),
    /session model endpoint override requires host-managed authorization/i,
  );
});

test('session customer gateway overrides require an explicit administrator allowlist', () => {
  const body = {
    modelConfig: {
      provider: 'custom-openai-compatible',
      baseUrl: 'https://east.gateway.corp/v1',
      model: 'enterprise-model',
      apiKey: 'dummy-gateway-key',
    },
  };
  assert.equal(hasSessionModelAccess(body, { env: {} }), false);
  assert.equal(hasSessionModelAccess(body, {
    env: { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: '*.gateway.corp' },
  }), true);
  const config = applySessionModelConfig({}, body, {
    env: { KCW_CUSTOMER_MODEL_GATEWAY_HOSTS: '*.gateway.corp' },
  });
  assert.equal(config.baseUrl, 'https://east.gateway.corp/v1');
  assert.equal(config.provider, 'custom-openai-compatible');
});

test('session model config rejects malformed scalar override fields', () => {
  assert.throws(
    () => applySessionModelConfig({}, { modelConfig: { model: 123 } }),
    /session model config: modelConfig\.model:/,
  );
});
