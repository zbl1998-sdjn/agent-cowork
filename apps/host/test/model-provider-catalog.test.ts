import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeFullModelId,
  findModelProviderCatalog,
  listModelProviderCatalog,
  modelProviderCatalogResponse,
  openCodeProviderCatalog,
  splitFullModelId,
  clearModelsDevCatalogCache,
  modelsDevProviderCatalogResponse,
} from '../src/kimi/provider/index.js';

test('model provider catalog exposes domestic, local, and opencode-style provider data', () => {
  const catalog = listModelProviderCatalog();
  const ids = catalog.map((item) => item.id);

  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('qwen-dashscope-cn'));
  assert.ok(ids.includes('zai-glm'));
  assert.ok(ids.includes('volcengine-ark'));
  assert.ok(ids.includes('siliconflow-cn'));
  assert.ok(ids.includes('ollama'));
  assert.ok(ids.includes('openai/local'));
  assert.ok(catalog.length >= 10);

  const response = modelProviderCatalogResponse();
  assert.equal(response.modelIdFormat, 'provider_id/model_id');
  assert.ok(response.catalog.all.deepseek);
  assert.equal(response.catalog.default.deepseek, 'deepseek-v4-flash');
  assert.equal(response.catalog.all.ollama?.options.requiresApiKey, false);
  assert.equal(response.catalog.default.ollama, 'qwen2.5:0.5b');
  assert.equal(response.catalog.all['openai/local']?.options.requiresApiKey, false);
});

test('catalog resolves aliases and full provider_id/model_id values', () => {
  assert.equal(findModelProviderCatalog('moonshot')?.id, 'kimi-api');
  assert.equal(findModelProviderCatalog('dashscope')?.id, 'qwen-dashscope-cn');

  assert.deepEqual(splitFullModelId('deepseek/deepseek-v4-flash'), {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    fullModelId: 'deepseek/deepseek-v4-flash',
  });
  assert.deepEqual(splitFullModelId('openai/local/qwen2.5-coder:7b'), {
    provider: 'openai/local',
    model: 'qwen2.5-coder:7b',
    fullModelId: 'openai/local/qwen2.5-coder:7b',
  });
  assert.deepEqual(splitFullModelId('ollama/qwen2.5:0.5b'), {
    provider: 'ollama',
    model: 'qwen2.5:0.5b',
    fullModelId: 'ollama/qwen2.5:0.5b',
  });
  assert.equal(composeFullModelId('dashscope', 'qwen3.7-plus'), 'qwen-dashscope-cn/qwen3.7-plus');
});

test('opencode-compatible catalog marks env-connected providers without echoing keys', () => {
  const catalog = openCodeProviderCatalog({ DEEPSEEK_API_KEY: 'test-secret-deepseek' });

  assert.ok(catalog.connected.includes('deepseek'));
  assert.equal(catalog.all.deepseek?.source, 'env');
  assert.deepEqual(catalog.all.deepseek?.env, ['DEEPSEEK_API_KEY']);
  assert.equal(JSON.stringify(catalog).includes('test-secret-deepseek'), false);
});

test('models.dev catalog adapter counts live-shaped catalogs and filters retired deepseek aliases', async () => {
  clearModelsDevCatalogCache();
  const catalog = await modelsDevProviderCatalogResponse({
    force: true,
    now: Date.parse('2026-07-02T00:00:00Z'),
    env: { DEEPSEEK_API_KEY: 'test-secret-deepseek' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          deepseek: {
            models: {
              'deepseek-v4-flash': {},
              'deepseek-v4-pro': {},
              'deepseek-chat': {},
              'deepseek-reasoner': {},
            },
          },
          moonshotai: { models: { 'kimi-k2.7-code': {}, 'kimi-k2.6': {} } },
        };
      },
    }),
  });

  assert.equal(catalog.source.id, 'models.dev');
  assert.equal(catalog.source.providerCount, 2);
  assert.equal(catalog.source.modelCount, 6);
  assert.equal(catalog.catalog.default.deepseek, 'deepseek-v4-flash');
  assert.deepEqual(Object.keys(catalog.catalog.all.deepseek?.models || {}), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(JSON.stringify(catalog).includes('test-secret-deepseek'), false);
});

test('models.dev catalog adapter falls back explicitly when fetch fails', async () => {
  clearModelsDevCatalogCache();
  const catalog = await modelsDevProviderCatalogResponse({
    force: true,
    fetchImpl: async () => {
      throw new Error('network unavailable');
    },
  });

  assert.equal(catalog.source.id, 'builtin');
  assert.match(String(catalog.source.error), /network unavailable/);
  assert.equal(catalog.catalog.default.deepseek, 'deepseek-v4-flash');
});
