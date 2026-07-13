import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callModelResilient, friendlyAgentError } from '../src/engine/agent-runner.js';
import { createTrustedInProcessModelCallCapability } from '../src/engine/agent/model-call-capability.js';
import type { ModelConfig } from '../src/engine/agent/model-resilience.js';

type ModelOutput = { content?: unknown; provider?: unknown; model?: unknown };
type FallbackSummary = { provider?: unknown };
type FallbackEvent = { failed: FallbackSummary; next: FallbackSummary; error: string };
type SeenModelConfig = Pick<ModelConfig, 'provider' | 'baseUrl' | 'model' | 'apiKey'>;

function auditedArgs(): { trustedRoot: string } {
  return { trustedRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-model-audit-')) };
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

test('callModelResilient passes a success through and supplies an abort signal', async () => {
  let sawSignal = false;
  const r = await callModelResilient(
    async ({ signal }) => { sawSignal = signal instanceof AbortSignal; return { content: 'ok' }; },
    auditedArgs(),
    { kimiConfig: { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11430/v1', model: 'm-pass' }, timeoutMs: 5000 },
  );
  assert.equal((r as ModelOutput).content, 'ok');
  assert.ok(sawSignal, 'modelCall must receive an AbortSignal');
});

test('callModelResilient rejects a caller-forged in-process capability object', async () => {
  let calls = 0;
  await assert.rejects(
    () => callModelResilient(
      async () => {
        calls += 1;
        return { content: 'must not run' };
      },
      auditedArgs(),
      {
        kimiConfig: {
          provider: 'kimi-api',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'external-model',
          securityMode: 'controlled_hybrid',
        },
        inProcessModelCallCapability: Object.freeze({}) as never,
        timeoutMs: 5000,
      },
    ),
    (err) => errorCode(err) === 'EGRESS_APPROVAL_REQUIRED',
  );
  assert.equal(calls, 0);
});

test('callModelResilient treats external-looking config as metadata for an explicit in-process adapter', async () => {
  let calls = 0;
  const modelCall = async ({ kimiConfig }: { kimiConfig: ModelConfig }) => {
    calls += 1;
    return { content: `observed ${String(kimiConfig.provider)}` };
  };
  const result = await callModelResilient(
    modelCall,
    auditedArgs(),
    {
      kimiConfig: {
        securityMode: 'controlled_hybrid',
        provider: 'kimi-api',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'external-looking-metadata',
      },
      inProcessModelCallCapability: createTrustedInProcessModelCallCapability(modelCall),
      timeoutMs: 5000,
    },
  );

  assert.equal((result as ModelOutput).content, 'observed kimi-api');
  assert.equal(calls, 1);
});

test('callModelResilient does not infer in-process trust from a fake model label', async () => {
  await assert.rejects(
    () => callModelResilient(
      async () => ({ content: 'must not run' }),
      auditedArgs(),
      { kimiConfig: { model: 'fake', securityMode: 'controlled_hybrid' }, timeoutMs: 5000 },
    ),
    (err) => errorCode(err) === 'EGRESS_APPROVAL_REQUIRED',
  );
});

test('callModelResilient opens the breaker after repeated failures', async () => {
  const cfg = { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11431/v1', model: 'm-open' };
  const fail = async () => { throw new Error('upstream boom'); };
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => callModelResilient(fail, auditedArgs(), { kimiConfig: cfg, timeoutMs: 5000 }));
  }
  // 5th call short-circuits (breaker open) instead of hitting the upstream.
  await assert.rejects(
    () => callModelResilient(fail, auditedArgs(), { kimiConfig: cfg, timeoutMs: 5000 }),
    (e) => errorCode(e) === 'CIRCUIT_OPEN',
  );
});

test('callModelResilient aborts a hung call via timeout', async () => {
  const cfg = { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11432/v1', model: 'm-timeout' };
  await assert.rejects(() => callModelResilient(
    ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    auditedArgs(),
    { kimiConfig: cfg, timeoutMs: 30 },
  ));
});

test('callModelResilient falls back to the next provider without inheriting the primary key', async () => {
  const seen: ModelConfig[] = [];
  const events: FallbackEvent[] = [];
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-test-dummy-0000000000',
    baseUrl: 'http://127.0.0.1:11433/v1',
    model: 'primary-model',
    fallbacks: [
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
    ],
  };

  const out = await callModelResilient(
    async ({ kimiConfig }) => {
      seen.push(kimiConfig);
      if (kimiConfig.provider === 'openai') {
        throw new Error('primary failed for sk-test-primary-secret-1234567890');
      }
      return { content: 'fallback ok', provider: kimiConfig.provider, model: kimiConfig.model };
    },
    auditedArgs(),
    { kimiConfig: cfg, timeoutMs: 5000, onFallback: (event) => events.push(event as FallbackEvent) },
  );

  const result = out as ModelOutput;
  assert.equal(result.content, 'fallback ok');
  assert.equal(result.provider, 'openai/local');
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.apiKey, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.failed.provider, 'openai');
  assert.equal(events[0]?.next.provider, 'openai/local');
  assert.ok(!String(events[0]?.error).includes('sk-test-primary-secret'), 'fallback event leaked primary key');
});

test('callModelResilient keeps same-provider fallbacks distinct by baseUrl and model', async () => {
  const seen: SeenModelConfig[] = [];
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-test-dummy-0000000000',
    baseUrl: 'http://127.0.0.1:11436/v1',
    model: 'gpt-primary',
    fallbacks: [
      { provider: 'openai', apiKey: 'sk-test-dummy-1111111111', baseUrl: 'http://127.0.0.1:11437/v1', model: 'gpt-fallback' },
    ],
  };

  const out = await callModelResilient(
    async ({ kimiConfig }) => {
      seen.push({ provider: kimiConfig.provider, baseUrl: kimiConfig.baseUrl, model: kimiConfig.model, apiKey: kimiConfig.apiKey });
      if (kimiConfig.baseUrl === 'http://127.0.0.1:11436/v1') {
        throw new Error('primary temporary outage');
      }
      return { content: 'same provider fallback ok', provider: kimiConfig.provider, model: kimiConfig.model };
    },
    auditedArgs(),
    { kimiConfig: cfg, timeoutMs: 5000 },
  );

  assert.equal((out as ModelOutput).content, 'same provider fallback ok');
  assert.deepEqual(seen.map((item) => item.baseUrl), ['http://127.0.0.1:11436/v1', 'http://127.0.0.1:11437/v1']);
  assert.equal(seen[1]?.apiKey, 'sk-test-dummy-1111111111');
});

test('callModelResilient skips external candidates before runtime calls in local strict mode', async () => {
  const seen: SeenModelConfig[] = [];
  const cfg = {
    securityMode: 'local_strict',
    provider: 'kimi-api',
    apiKey: 'test-external-denied',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'external-denied-model',
    fallbacks: [
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-allowed-model' },
    ],
  };

  const out = await callModelResilient(
    async ({ kimiConfig }) => {
      seen.push({ provider: kimiConfig.provider, baseUrl: kimiConfig.baseUrl, model: kimiConfig.model, apiKey: kimiConfig.apiKey });
      return { content: 'local ok', provider: kimiConfig.provider, model: kimiConfig.model };
    },
    auditedArgs(),
    { kimiConfig: cfg, timeoutMs: 5000 },
  );

  assert.equal((out as ModelOutput).content, 'local ok');
  assert.deepEqual(seen.map((item) => item.provider), ['openai/local']);
  assert.equal(seen[0]?.apiKey, undefined);
});

test('callModelResilient fails closed when local strict leaves no allowed model candidate', async () => {
  await assert.rejects(
    () => callModelResilient(
      async () => ({ content: 'should not run' }),
      auditedArgs(),
      {
        kimiConfig: {
          securityMode: 'local_strict',
          provider: 'kimi-api',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'external-only-model',
        },
        timeoutMs: 5000,
      },
    ),
    (err) => errorCode(err) === 'MODEL_PROVIDER_POLICY_DENIED',
  );
});

test('callModelResilient does not invoke or fall back from unapproved controlled hybrid egress', async () => {
  let calls = 0;
  await assert.rejects(
    () => callModelResilient(
      async () => {
        calls += 1;
        return { content: 'must not run' };
      },
      auditedArgs(),
      {
        kimiConfig: {
          securityMode: 'controlled_hybrid',
          provider: 'kimi-api',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'external-needs-approval',
          fallbacks: [
            { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-fallback' },
          ],
        },
        timeoutMs: 5000,
      },
    ),
    (err) => errorCode(err) === 'EGRESS_APPROVAL_REQUIRED'
      && (err as { approvalCapability?: unknown }).approvalCapability === 'unavailable'
      && (err as { approvalReceiptRequirements?: unknown[] }).approvalReceiptRequirements?.includes('single_use') === true,
  );
  assert.equal(calls, 0);
});

test('callModelResilient reports exhausted fallback chains with redacted layer errors', async () => {
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-test-dummy-0000000000',
    baseUrl: 'http://127.0.0.1:11438/v1',
    model: 'primary-exhaust',
    fallbacks: [
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11435/v1', model: 'local-exhaust' },
    ],
  };

  await assert.rejects(
    () => callModelResilient(
      async ({ kimiConfig }) => {
        throw new Error(`failed ${kimiConfig.provider} sk-test-exhaust-secret-1234567890`);
      },
      auditedArgs(),
      { kimiConfig: cfg, timeoutMs: 5000 },
    ),
    (err) => errorCode(err) === 'FALLBACK_EXHAUSTED' && !errorMessage(err).includes('sk-test-exhaust-secret'),
  );
});

test('callModelResilient does not fall back on auth or 4xx configuration errors', async () => {
  const seen: unknown[] = [];
  const events: FallbackEvent[] = [];
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-test-auth-secret-1234567890',
    baseUrl: 'http://127.0.0.1:11439/v1',
    model: 'auth-model',
    fallbacks: [
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
    ],
  };

  await assert.rejects(
    () => callModelResilient(
      async ({ kimiConfig }) => {
        seen.push(kimiConfig.provider);
        throw new Error('OpenAI request failed with status 401: invalid api key');
      },
      auditedArgs(),
      { kimiConfig: cfg, timeoutMs: 5000, onFallback: (event) => events.push(event as FallbackEvent) },
    ),
    /status 401/,
  );

  assert.deepEqual(seen, ['openai']);
  assert.deepEqual(events, []);
});

test('friendlyAgentError degrades known states and redacts everything else', () => {
  assert.match(friendlyAgentError({ code: 'CIRCUIT_OPEN' }, { traceId: 't1' }), /熔断/);
  assert.match(friendlyAgentError({ code: 'CIRCUIT_OPEN' }, { traceId: 't1' }), /t1/);
  assert.match(friendlyAgentError({ code: 'ETIMEDOUT' }, {}), /超时/);
  const leaky = friendlyAgentError({ message: 'failed for key sk-test-live-key-1234567890abc' }, {});
  assert.ok(!leaky.includes('sk-test-live-key'), 'error message must be redacted');
});

test('friendlyAgentError turns connection failures into actionable guidance', () => {
  // Node fetch 连不上本地模型:message="fetch failed",cause.code=ECONNREFUSED
  const byMsg = friendlyAgentError({ message: 'fetch failed' }, { traceId: 't2' });
  assert.match(byMsg, /无法连接模型服务/);
  assert.match(byMsg, /Ollama/);
  assert.match(byMsg, /t2/);
  const byCause = friendlyAgentError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }, {});
  assert.match(byCause, /无法连接模型服务/);
  // 不误伤普通错误
  assert.ok(!/无法连接模型服务/.test(friendlyAgentError({ message: 'invalid request' }, {})));
});
