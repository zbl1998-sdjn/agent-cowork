import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTestWorkspace } from './test-fixtures.js';
import {
  CONFIG_SECRET,
  persistedConfigPath,
  postKimiConfig,
  readConfigResponse,
  readErrorResponse,
  readKimiInfo,
  readPersistedConfig,
  withKimiConfigServer,
} from './helpers/kimi-config.js';

test('POST /api/kimi/config stores key without claiming policy-blocked cloud calls are enabled', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg');
  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    let info = (await readKimiInfo(baseUrl)).body;
    assert.equal(info.configured, false);
    assert.equal(info.hasKey, false);
    assert.equal(info.chatEnabled, false);

    const response = await postKimiConfig(baseUrl, {
      apiKey: CONFIG_SECRET,
      baseUrl: 'https://api.moonshot.cn/v1/',
      model: 'kimi-k2-test',
    });
    assert.equal(response.status, 200);
    const { raw, body } = await readConfigResponse(response);
    // Plaintext keys must never appear in route responses.
    assert.ok(!raw.includes(CONFIG_SECRET), 'config response leaked the API key');
    assert.equal(body.hasKey, true);
    assert.equal(body.configured, true);
    assert.equal(body.chatEnabled, false);
    assert.equal(body.planEnabled, false);
    assert.equal(body.baseUrl, 'https://api.moonshot.cn/v1');
    assert.equal(body.model, 'kimi-k2-test');
    assert.equal(body.apiKey, undefined);

    const infoPayload = await readKimiInfo(baseUrl);
    assert.ok(!infoPayload.raw.includes(CONFIG_SECRET), 'info response leaked the API key');
    info = infoPayload.body;
    assert.equal(info.hasKey, true);
    assert.equal(info.configured, true);
    assert.equal(info.chatEnabled, false);
    const active = info.providerStates?.find((item) => item.provider === 'kimi-api');
    assert.equal(active?.configured, true);
    assert.equal(active?.enabled, false);
    assert.equal(active?.policyDecision, 'needs_approval');
    assert.equal(info.model, 'kimi-k2-test');
  });

  assert.ok(fs.existsSync(persistedConfigPath(trustedRoot)), 'config.json was not written');
  const persisted = readPersistedConfig(trustedRoot);
  // 路由测试注入确定性的 AES-GCM 保护器；默认 Windows DPAPI 由独立保护器测试覆盖。
  assert.ok(persisted.kimiApi.apiKey !== CONFIG_SECRET, 'apiKey persisted as plaintext');
  assert.match(String(persisted.kimiApi.apiKey), /^aesgcm:v1:/);
  assert.ok(!fs.readFileSync(persistedConfigPath(trustedRoot), 'utf8').includes(CONFIG_SECRET), 'config.json leaked the plaintext API key');
  assert.equal(persisted.kimiApi.model, 'kimi-k2-test');
});

test('persisted config is reloaded on a fresh server boot (survives restart)', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-reload');
  fs.mkdirSync(path.join(trustedRoot, '.AgentCowork'), { recursive: true });
  fs.writeFileSync(
    persistedConfigPath(trustedRoot),
    JSON.stringify({ kimiApi: { apiKey: CONFIG_SECRET, baseUrl: 'https://x.example/v1', model: 'persisted-model' } }),
    'utf8',
  );

  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    const info = (await readKimiInfo(baseUrl)).body;
    assert.equal(info.hasKey, true);
    assert.equal(info.configured, true);
    assert.equal(info.chatEnabled, false);
    assert.equal(info.model, 'persisted-model');
    assert.equal(info.baseUrl, 'https://x.example/v1');
  });
});

test('POST /api/kimi/config rejects non-object JSON bodies without changing config', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-invalid-body');
  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    await postKimiConfig(baseUrl, { apiKey: CONFIG_SECRET, model: 'stable-model' });

    const response = await postKimiConfig(baseUrl, []);
    assert.equal(response.status, 400);
    assert.match((await readErrorResponse(response)).error, /invalid kimi config request/i);

    const info = (await readKimiInfo(baseUrl)).body;
    assert.equal(info.hasKey, true);
    assert.equal(info.model, 'stable-model');
  });
});

test('clearKey wipes the stored key and disables the API', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-clear');
  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    await postKimiConfig(baseUrl, { apiKey: CONFIG_SECRET });
    let info = (await readKimiInfo(baseUrl)).body;
    assert.equal(info.hasKey, true);

    const response = await postKimiConfig(baseUrl, { clearKey: true });
    const { body } = await readConfigResponse(response);
    assert.equal(body.hasKey, false);
    assert.equal(body.configured, false);
    assert.equal(body.chatEnabled, false);

    info = (await readKimiInfo(baseUrl)).body;
    assert.equal(info.hasKey, false);
    assert.equal(info.configured, false);
  });
});

test('updating only baseUrl/model keeps the existing key intact', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-partial');
  await withKimiConfigServer({ trustedRoot }, async (baseUrl) => {
    await postKimiConfig(baseUrl, { apiKey: CONFIG_SECRET, model: 'm1' });
    const response = await postKimiConfig(baseUrl, { model: 'm2', baseUrl: 'https://y.example/v1' });
    const { body } = await readConfigResponse(response);
    assert.equal(body.hasKey, true);
    assert.equal(body.model, 'm2');
    assert.equal(body.baseUrl, 'https://y.example/v1');
  });
});

test('a persistence failure rolls back in-memory Kimi config and does not leak the key', async () => {
  const trustedRoot = makeTestWorkspace('kcw-kimicfg-persist-failure');
  const failingProtector = {
    protect() { throw new Error(`failed to seal ${CONFIG_SECRET}`); },
    unprotect(value: string) { return value; },
  };
  await withKimiConfigServer({ trustedRoot, kimiConfigProtector: failingProtector }, async (baseUrl) => {
    const before = (await readKimiInfo(baseUrl)).body as Record<string, unknown>;
    const response = await postKimiConfig(baseUrl, {
      provider: 'openai',
      apiKey: CONFIG_SECRET,
      baseUrl: 'https://new.example.test/v1',
      model: 'new-model-must-roll-back',
    });
    const raw = await response.text();
    assert.equal(response.status, 500);
    assert.equal(raw.includes(CONFIG_SECRET), false, 'persistence errors must not echo credentials');

    const after = (await readKimiInfo(baseUrl)).body as Record<string, unknown>;
    for (const key of ['provider', 'configured', 'hasKey', 'chatEnabled', 'planEnabled', 'baseUrl', 'model', 'fullModelId']) {
      assert.deepEqual(after[key], before[key], `${key} must roll back after persistence failure`);
    }
    assert.equal(fs.existsSync(persistedConfigPath(trustedRoot)), false);
  });
});
