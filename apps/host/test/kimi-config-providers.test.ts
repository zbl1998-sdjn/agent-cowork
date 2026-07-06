import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  modelProvider,
  runKimiAndRecord,
  sendKimiInfo,
  type KimiRouteState,
} from '../src/routes/kimi-route-support.js';
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

class CapturingJsonResponse {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = '';

  writeHead(statusCode: number, headers: Record<string, string | number> = {}): void {
    this.statusCode = statusCode;
    this.headers = { ...headers };
  }

  end(chunk: string | Buffer = ''): void {
    this.body += String(chunk);
  }

  json(): Record<string, unknown> {
    assert.ok(this.body, 'response body should be present');
    const parsed = JSON.parse(this.body) as unknown;
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'response body should be an object');
    return parsed as Record<string, unknown>;
  }
}

function kimiRouteState(root: string, overrides: Partial<KimiRouteState> = {}): KimiRouteState {
  const indexed: Array<{ record: Record<string, unknown>; context: Record<string, unknown> }> = [];
  return {
    config: { fetchImpl: async () => new Response('{}') },
    runStoreRoot: root,
    memoryStore: {
      loadMemoryContext: () => ({ enabled: false, text: '' }),
    },
    kimiApiConfig: {
      provider: ' OpenAI ',
      configured: true,
      apiKey: 'test-route-support-key',
      baseUrl: 'https://api.example.test/v1',
      model: 'route-support-model',
      timeoutMs: 1234,
      maxTokens: 99,
      userAgent: 'agent-cowork-test',
      temperature: 0.2,
    },
    kimiApiEnabled: true,
    kimiPlanRunner: async () => ({ ok: true }),
    kimiChatRunner: async () => ({ ok: true }),
    kimiChatStreamRunner: async () => ({ text: '' }),
    recomputeKimiEnabled: () => undefined,
    persistKimiConfig: () => undefined,
    indexRun: (record: Record<string, unknown>, context: Record<string, unknown>) => { indexed.push({ record, context }); },
    agentConcurrency: { tryAcquire: () => () => undefined },
    indexed,
    ...overrides,
  } as unknown as KimiRouteState;
}

function runRecordFromPath(runPath: unknown): Record<string, unknown> {
  if (typeof runPath !== 'string') throw new TypeError('runPath should be a string');
  const parsed = JSON.parse(fs.readFileSync(runPath, 'utf8')) as unknown;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'run record should be an object');
  return parsed as Record<string, unknown>;
}

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

test('sendKimiInfo normalizes providers and summarizes fallback keys without echoing secrets', async () => {
  const root = makeTestWorkspace('kcw-kimi-route-info');
  const response = new CapturingJsonResponse();
  const state = kimiRouteState(root, {
    kimiApiConfig: {
      provider: '  ',
      configured: true,
      apiKey: CONFIG_SECRET,
      baseUrl: 'https://api.example.test/v1',
      model: 'primary-model',
      fallbacks: [
        { provider: 'OpenAI/Local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
        { provider: 'Anthropic', apiKey: FALLBACK_SECRET, baseUrl: 'https://anthropic.example.test', model: 'claude-test' },
        'malformed-fallback',
      ],
    },
  } as Partial<KimiRouteState>);

  assert.equal(modelProvider(null), 'kimi-api');
  assert.equal(modelProvider({ provider: ' OpenAI ' }), 'openai');
  await sendKimiInfo(response, state);

  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes(CONFIG_SECRET), 'info response leaked primary key');
  assert.ok(!response.body.includes(FALLBACK_SECRET), 'info response leaked fallback key');
  const body = response.json();
  assert.equal(body.provider, 'kimi-api');
  assert.equal(body.hasKey, true);
  assert.equal(body.fullModelId, 'kimi-api/primary-model');
  assert.equal(body.modelIdFormat, 'provider_id/model_id');
  assert.equal((body.catalogSource as Record<string, unknown> | undefined)?.id, 'models.dev');
  assert.ok(Array.isArray(body.providers));
  assert.ok((body.providers as Array<Record<string, unknown>>).some((item) => item.id === 'deepseek'));
  const catalog = body.catalog as Record<string, unknown>;
  assert.ok(catalog && typeof catalog === 'object');
  const fallbacks = body.fallbacks as Array<Record<string, unknown>>;
  assert.equal(fallbacks.length, 3);
  assert.equal(fallbacks[0]?.provider, 'openai/local');
  assert.equal(fallbacks[0]?.hasKey, false);
  assert.equal(fallbacks[1]?.provider, 'anthropic');
  assert.equal(fallbacks[1]?.hasKey, true);
  assert.equal(Object.hasOwn(fallbacks[1] || {}, 'apiKey'), false);
  assert.equal(fallbacks[2]?.provider, 'kimi-api');
});

test('runKimiAndRecord writes success evidence, indexes the run, and returns only memory metadata', async () => {
  const root = makeTestWorkspace('kcw-kimi-route-success');
  const response = new CapturingJsonResponse();
  const runnerCalls: Record<string, unknown>[] = [];
  const state = kimiRouteState(root, {
    memoryStore: {
      loadMemoryContext: (trustedRoot, options) => {
        assert.equal(trustedRoot, root);
        assert.equal(options.maxBytes, 4096);
        assert.equal(options.context.traceId, 'trace_kimi_route');
        return { enabled: true, bytes: 12, notes: [{ name: 'note.md' }], text: 'memory text that must stay out of the response' };
      },
    },
    kimiApiConfig: {
      provider: 'OpenAI',
      configured: true,
      apiKey: CONFIG_SECRET,
      baseUrl: 'https://api.example.test/v1',
      model: 'route-model',
      timeoutMs: 4321,
      maxTokens: 77,
      userAgent: 'route-test-agent',
      temperature: 0.4,
    },
  } as Partial<KimiRouteState>);
  const context = {
    traceId: 'trace_kimi_route',
    tenantId: 'tenant_kimi',
    userId: 'user_kimi',
    authenticated: true,
    idempotencyKey: 'idem_kimi',
  };

  await runKimiAndRecord({
    state,
    type: 'kimi-chat',
    mode: 'chat',
    trustedRoot: root,
    prompt: 'hello',
    summary: 'short summary',
    runner: async (options) => {
      runnerCalls.push(options);
      return {
        ok: true,
        text: 'done',
        provider: 'fallback-provider',
        model: 'fallback-model',
        usage: { total_tokens: 9 },
        durationMs: 42,
      };
    },
    response,
    context,
  });

  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes('memory text that must stay out of the response'));
  const body = response.json();
  assert.equal(body.runId, String(body.runId));
  assert.equal(body.runPath, String(body.runPath));
  assert.deepEqual(body.memory, { enabled: true, bytes: 12, notes: [{ name: 'note.md' }] });
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0]?.memory, 'memory text that must stay out of the response');
  assert.equal(runnerCalls[0]?.apiKey, CONFIG_SECRET);
  assert.equal(runnerCalls[0]?.provider, 'openai');
  assert.equal(runnerCalls[0]?.fetchImpl, state.config.fetchImpl);

  const runRecord = runRecordFromPath(body.runPath);
  assert.equal(runRecord.status, 'succeeded');
  assert.equal(runRecord.provider, 'openai');
  assert.deepEqual(runRecord.memory, { enabled: true, bytes: 12, notes: [{ name: 'note.md' }] });
  const result = runRecord.result as Record<string, unknown>;
  assert.equal(result.text, 'done');
  assert.equal(result.provider, 'fallback-provider');
  assert.deepEqual(result.usage, { total_tokens: 9 });
  const indexed = (state as unknown as { indexed: Array<{ record: Record<string, unknown>; context: Record<string, unknown> }> }).indexed;
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0]?.record.status, 'succeeded');
  assert.equal(indexed[0]?.record.runPath, body.runPath);
  assert.deepEqual(indexed[0]?.context, context);
});

test('runKimiAndRecord writes failed evidence and maps runner timeouts to 504', async () => {
  const root = makeTestWorkspace('kcw-kimi-route-failure');
  const response = new CapturingJsonResponse();
  const state = kimiRouteState(root);
  const context = {
    traceId: 'trace_kimi_route_fail',
    tenantId: 'tenant_kimi',
    userId: 'user_kimi',
    authenticated: true,
    idempotencyKey: 'idem_kimi_fail',
  };

  await assert.rejects(
    () => runKimiAndRecord({
      state,
      type: 'kimi-plan',
      mode: 'plan',
      trustedRoot: root,
      prompt: 'plan this',
      runner: async () => {
        throw new Error('model timed out while waiting');
      },
      response,
      context,
    }),
    (err: unknown) => {
      const routeError = err as { statusCode?: unknown; payload?: Record<string, unknown>; message?: string };
      assert.equal(routeError.statusCode, 504);
      assert.match(String(routeError.message), /timed out/);
      assert.equal(typeof routeError.payload?.runId, 'string');
      assert.equal(typeof routeError.payload?.runPath, 'string');
      const runRecord = runRecordFromPath(routeError.payload?.runPath);
      assert.equal(runRecord.status, 'failed');
      assert.deepEqual(runRecord.error, { message: 'model timed out while waiting' });
      return true;
    },
  );

  assert.equal(response.body, '');
  const indexed = (state as unknown as { indexed: Array<{ record: Record<string, unknown>; context: Record<string, unknown> }> }).indexed;
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0]?.record.status, 'failed');
  assert.deepEqual(indexed[0]?.record.error, { message: 'model timed out while waiting' });
  assert.deepEqual(indexed[0]?.context, context);
});
