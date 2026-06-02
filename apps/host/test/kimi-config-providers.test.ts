import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTestWorkspace } from './test-fixtures.js';
import {
  CONFIG_SECRET,
  FALLBACK_SECRET,
  postKimiConfig,
  readConfigResponse,
  readKimiInfo,
  readPersistedConfig,
  withKimiConfigServer,
} from './helpers/kimi-config.js';

test('POST /api/kimi/config stores provider without echoing the key', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-provider');
  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    const response = await postKimiConfig(baseUrl, {
      provider: 'OPENAI',
      apiKey: CONFIG_SECRET,
      baseUrl: 'https://api.openai.test/v1/',
      model: 'gpt-test',
    });
    assert.equal(response.status, 200);
    const { raw, body } = await readConfigResponse(response);
    assert.ok(!raw.includes(CONFIG_SECRET), 'config response leaked the API key');
    assert.equal(body.provider, 'openai');
    assert.equal(body.hasKey, true);
    assert.equal(body.baseUrl, 'https://api.openai.test/v1');
    assert.equal(body.model, 'gpt-test');
  });

  const persisted = readPersistedConfig(trustedRoot);
  assert.equal(persisted.kimiApi.provider, 'openai');
  assert.equal(persisted.kimiApi.apiKey, CONFIG_SECRET);

  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    const info = (await readKimiInfo(baseUrl)).body;
    assert.equal(info.provider, 'openai');
    assert.equal(info.hasKey, true);
    assert.equal(info.model, 'gpt-test');
  });
});

test('POST /api/kimi/config stores fallback providers without echoing fallback keys', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-fallbacks');
  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    const response = await postKimiConfig(baseUrl, {
      provider: 'openai',
      apiKey: CONFIG_SECRET,
      model: 'gpt-primary',
      fallbacks: [
        { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'local-model' },
        { provider: 'openai', apiKey: FALLBACK_SECRET, baseUrl: 'https://fallback.example/v1', model: 'gpt-fallback' },
      ],
    });
    assert.equal(response.status, 200);
    const { raw, body } = await readConfigResponse(response);
    assert.ok(!raw.includes(CONFIG_SECRET), 'config response leaked the primary API key');
    assert.ok(!raw.includes(FALLBACK_SECRET), 'config response leaked the fallback API key');

    assert.equal(body.fallbacks?.length, 2);
    const first = body.fallbacks?.[0];
    const second = body.fallbacks?.[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.provider, 'openai/local');
    assert.equal(first.hasKey, false);
    assert.equal(second.provider, 'openai');
    assert.equal(second.hasKey, true);
    assert.equal(second.apiKey, undefined);
  });

  const persisted = readPersistedConfig(trustedRoot);
  const firstPersisted = persisted.kimiApi.fallbacks?.[0];
  const secondPersisted = persisted.kimiApi.fallbacks?.[1];
  assert.ok(firstPersisted);
  assert.ok(secondPersisted);
  assert.equal(firstPersisted.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(secondPersisted.apiKey, FALLBACK_SECRET);

  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    const infoPayload = await readKimiInfo(baseUrl);
    assert.ok(!infoPayload.raw.includes(FALLBACK_SECRET), 'info response leaked the fallback API key');
    const fallback = infoPayload.body.fallbacks?.[1];
    assert.ok(fallback);
    assert.equal(fallback.hasKey, true);
    assert.equal(fallback.model, 'gpt-fallback');
  });
});
