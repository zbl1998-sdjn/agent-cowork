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
        baseUrl: 'https://api.local.test/v1///',
        model: ' gpt-local ',
        apiKey: ' test-session-key ',
        fallbacks: [{ provider: 'openai', apiKey: 'test-request-fallback-key' }],
      },
    },
  );

  assert.equal(config.provider, 'local-openai');
  assert.equal(config.baseUrl, 'https://api.local.test/v1');
  assert.equal(config.model, 'gpt-local');
  assert.equal(config.apiKey, 'test-session-key');
  assert.deepEqual(config.fallbacks, fallback);
  assert.equal(hasSessionModelAccess({ modelConfig: { provider: ' OPENAI/LOCAL ' } }), true);
});

test('session model config rejects malformed scalar override fields', () => {
  assert.throws(
    () => applySessionModelConfig({}, { modelConfig: { model: 123 } }),
    /session model config: modelConfig\.model:/,
  );
});
