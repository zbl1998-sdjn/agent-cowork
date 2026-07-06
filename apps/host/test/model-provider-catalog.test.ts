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
  assert.equal(response.catalog.default['kimi-api'], 'kimi-k2.7-code');
  assert.equal(response.catalog.default.openai, 'gpt-5.5');
  assert.equal(response.catalog.default.anthropic, 'claude-sonnet-5');
  assert.equal(response.catalog.default.google, 'gemini-3.5-flash');
  assert.equal(response.catalog.default.xai, 'grok-4.3');
  assert.equal(response.catalog.default.openrouter, 'anthropic/claude-sonnet-5');
  assert.equal(response.catalog.all.ollama?.options.requiresApiKey, false);
  assert.equal(response.catalog.default.ollama, 'qwen3');
  assert.equal(response.catalog.all['openai/local']?.options.requiresApiKey, false);
  assert.equal(response.catalog.default['openai/local'], 'qwen3');
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

test('models.dev catalog adapter counts live-shaped catalogs and filters retired provider aliases', async () => {
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
              'deepseek-r1': {},
            },
          },
          moonshotai: {
            models: {
              'kimi-k2.7-code': {},
              'kimi-k2.7-code-highspeed': {},
              'kimi-k2.6': {},
              'kimi-k2-thinking': {},
              'kimi-k2-thinking-turbo': {},
              'kimi-k2-0711-preview': {},
              'kimi-k2-turbo-preview': {},
            },
          },
          google: {
            models: {
              'gemini-3.5-flash': {},
              'gemini-3-pro-preview': {},
              'gemini-2.5-pro': {},
            },
          },
          xai: {
            models: {
              'grok-4.3': {},
              'grok-build-0.1': {},
              'grok-4.20-0309-reasoning': {},
            },
          },
          openai: {
            models: {
              'gpt-5.5': {},
              'gpt-5.3-codex': {},
              'gpt-5.2': {},
              'gpt-image-1': {},
            },
          },
        };
      },
    }),
  });

  assert.equal(catalog.source.id, 'models.dev');
  assert.equal(catalog.source.providerCount, 5);
  assert.equal(catalog.source.modelCount, 22);
  assert.equal(catalog.catalog.default.deepseek, 'deepseek-v4-flash');
  assert.equal(catalog.catalog.default.openai, 'gpt-5.5');
  assert.deepEqual(Object.keys(catalog.catalog.all.deepseek?.models || {}), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(catalog.catalog.default['kimi-api'], 'kimi-k2.7-code');
  assert.deepEqual(Object.keys(catalog.catalog.all['kimi-api']?.models || {}), ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6']);
  assert.equal(catalog.catalog.default.google, 'gemini-3.5-flash');
  assert.equal(Object.keys(catalog.catalog.all.google?.models || {}).includes('gemini-3-pro-preview'), false);
  assert.equal(catalog.catalog.default.xai, 'grok-4.3');
  assert.equal(Object.keys(catalog.catalog.all.xai?.models || {}).includes('grok-4.20-0309-reasoning'), false);
  assert.equal(catalog.catalog.default.openai, 'gpt-5.5');
  assert.equal(Object.keys(catalog.catalog.all.openai?.models || {}).includes('gpt-5.2'), false);
  assert.equal(Object.keys(catalog.catalog.all.openai?.models || {}).includes('gpt-image-1'), false);
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
  assert.equal(catalog.catalog.default.openai, 'gpt-5.5');
});
