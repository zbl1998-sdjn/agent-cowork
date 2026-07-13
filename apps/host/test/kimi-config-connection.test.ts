import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTestWorkspace } from './test-fixtures.js';
import {
  postKimiConfig,
  postKimiTest,
  readConfigResponse,
  withKimiConfigServer,
} from './helpers/kimi-config.js';

test('POST /api/agent-engine/test discovers local models without persisting or echoing credentials', async () => {
  const trustedRoot = makeTestWorkspace('kcw-model-connection');
  const secret = 'test-connection-secret';
  await withKimiConfigServer({
    trustedRoot,
    securityMode: 'local_strict',
    fetchImpl: async (url: string) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/models');
      return new Response(JSON.stringify({
        data: [{ id: 'qwen3:14b' }, { id: 'qwen2.5:0.5b' }],
      }), { status: 200 });
    },
  }, async (baseUrl) => {
    const response = await postKimiTest(baseUrl, {
      action: 'models',
      provider: 'ollama',
      apiKey: secret,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:14b',
    });
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.equal(raw.includes(secret), false);
    const body = JSON.parse(raw) as {
      connection?: { status?: string; modelAvailable?: boolean };
      models?: string[];
    };
    assert.equal(body.connection?.status, 'connected');
    assert.equal(body.connection?.modelAvailable, true);
    assert.deepEqual(body.models, ['qwen3:14b', 'qwen2.5:0.5b']);
  });
});

test('POST /api/agent-engine/test reports a missing local model as a usable validation result', async () => {
  const trustedRoot = makeTestWorkspace('kcw-model-missing');
  await withKimiConfigServer({
    trustedRoot,
    securityMode: 'local_strict',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'installed-model' }] }), { status: 200 }),
  }, async (baseUrl) => {
    const response = await postKimiTest(baseUrl, {
      action: 'models',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'missing-model',
    });
    const body = await response.json() as { connection?: { status?: string } };
    assert.equal(response.status, 200);
    assert.equal(body.connection?.status, 'model_missing');
  });
});

test('POST /api/agent-engine/test is read-only for ordinary users while config writes stay admin-only', async () => {
  const trustedRoot = makeTestWorkspace('kcw-model-ordinary-user-test');
  await withKimiConfigServer({
    trustedRoot,
    globalMutationAdmins: [],
    securityMode: 'local_strict',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 }),
  }, async (baseUrl) => {
    const testResponse = await postKimiTest(baseUrl, {
      action: 'models',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
    });
    assert.equal(testResponse.status, 200);
    const configResponse = await postKimiConfig(baseUrl, { provider: 'ollama' });
    assert.equal(configResponse.status, 403);
  });
});

test('saved local config stays disabled until the selected model is actually available', async () => {
  const trustedRoot = makeTestWorkspace('kcw-model-effective-status');
  await withKimiConfigServer({
    trustedRoot,
    securityMode: 'local_strict',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'installed-model' }] }), { status: 200 }),
  }, async (baseUrl) => {
    const response = await postKimiConfig(baseUrl, {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'missing-model',
    });
    const { body } = await readConfigResponse(response);
    assert.equal(body.configured, true);
    assert.equal(body.chatEnabled, false);
    assert.equal(body.providerStates?.find((item) => item.provider === 'ollama')?.enabled, false);
    assert.equal((body as Record<string, unknown>).connection && ((body as Record<string, unknown>).connection as { status?: string }).status, 'model_missing');
  });
});
