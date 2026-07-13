import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverProviderModels } from '../src/engine/model-discovery.js';

const LOCAL_CONFIG = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:14b',
  securityMode: 'local_strict',
} as const;

test('discoverProviderModels parses OpenAI model lists and verifies the selected model', async () => {
  const result = await discoverProviderModels({
    ...LOCAL_CONFIG,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/models');
      assert.equal((init?.headers as Record<string, string>).authorization, undefined);
      return new Response(JSON.stringify({
        data: [{ id: 'qwen3:14b' }, { id: 'qwen2.5:0.5b' }],
      }), { status: 200 });
    },
  });

  assert.equal(result.status, 'connected');
  assert.equal(result.modelAvailable, true);
  assert.deepEqual(result.models, ['qwen3:14b', 'qwen2.5:0.5b']);
});

test('discoverProviderModels parses Ollama-style lists and reports a missing selected model', async () => {
  const result = await discoverProviderModels({
    ...LOCAL_CONFIG,
    model: 'not-installed',
    fetchImpl: async () => new Response(JSON.stringify({
      models: [{ name: 'qwen3:14b' }, { model: 'deepseek-r1:7b' }],
    }), { status: 200 }),
  });

  assert.equal(result.status, 'model_missing');
  assert.equal(result.modelAvailable, false);
  assert.deepEqual(result.models, ['qwen3:14b', 'deepseek-r1:7b']);
});

test('discoverProviderModels returns a bounded unreachable result without leaking credentials', async () => {
  const secret = 'test-model-discovery-secret';
  const result = await discoverProviderModels({
    ...LOCAL_CONFIG,
    apiKey: secret,
    fetchImpl: async () => new Response('backend unavailable', { status: 503 }),
  });

  assert.equal(result.status, 'unreachable');
  assert.match(result.error || '', /HTTP 503/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
