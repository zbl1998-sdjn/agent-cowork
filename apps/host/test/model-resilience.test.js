import test from 'node:test';
import assert from 'node:assert/strict';
import { callModelResilient, friendlyAgentError } from '../src/kimi/agent-runner.js';

test('callModelResilient passes a success through and supplies an abort signal', async () => {
  let sawSignal = false;
  const r = await callModelResilient(
    async ({ signal }) => { sawSignal = signal instanceof AbortSignal; return { content: 'ok' }; },
    {},
    { kimiConfig: { baseUrl: 'u-pass', model: 'm-pass' }, timeoutMs: 5000 },
  );
  assert.equal(r.content, 'ok');
  assert.ok(sawSignal, 'modelCall must receive an AbortSignal');
});

test('callModelResilient opens the breaker after repeated failures', async () => {
  const cfg = { baseUrl: 'u-open', model: 'm-open' };
  const fail = async () => { throw new Error('upstream boom'); };
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => callModelResilient(fail, {}, { kimiConfig: cfg, timeoutMs: 5000 }));
  }
  // 5th call short-circuits (breaker open) instead of hitting the upstream.
  await assert.rejects(
    () => callModelResilient(fail, {}, { kimiConfig: cfg, timeoutMs: 5000 }),
    (e) => e.code === 'CIRCUIT_OPEN',
  );
});

test('callModelResilient aborts a hung call via timeout', async () => {
  const cfg = { baseUrl: 'u-timeout', model: 'm-timeout' };
  await assert.rejects(() => callModelResilient(
    ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    {},
    { kimiConfig: cfg, timeoutMs: 30 },
  ));
});

test('callModelResilient falls back to the next provider without inheriting the primary key', async () => {
  const seen = [];
  const events = [];
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-PRIMARYSECRET1234567890',
    baseUrl: 'https://primary.example/v1',
    model: 'primary-model',
    fallbacks: [
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' },
    ],
  };

  const out = await callModelResilient(
    async ({ kimiConfig }) => {
      seen.push(kimiConfig);
      if (kimiConfig.provider === 'openai') {
        throw new Error('primary failed for sk-PRIMARYSECRET1234567890');
      }
      return { content: 'fallback ok', provider: kimiConfig.provider, model: kimiConfig.model };
    },
    {},
    { kimiConfig: cfg, timeoutMs: 5000, onFallback: (event) => events.push(event) },
  );

  assert.equal(out.content, 'fallback ok');
  assert.equal(out.provider, 'openai/local');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].apiKey, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].failed.provider, 'openai');
  assert.equal(events[0].next.provider, 'openai/local');
  assert.ok(!events[0].error.includes('sk-PRIMARYSECRET'), 'fallback event leaked primary key');
});

test('callModelResilient keeps same-provider fallbacks distinct by baseUrl and model', async () => {
  const seen = [];
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-primary-same-provider-123456',
    baseUrl: 'https://primary-openai.example/v1',
    model: 'gpt-primary',
    fallbacks: [
      { provider: 'openai', apiKey: 'sk-fallback-same-provider-123456', baseUrl: 'https://fallback-openai.example/v1', model: 'gpt-fallback' },
    ],
  };

  const out = await callModelResilient(
    async ({ kimiConfig }) => {
      seen.push({ provider: kimiConfig.provider, baseUrl: kimiConfig.baseUrl, model: kimiConfig.model, apiKey: kimiConfig.apiKey });
      if (kimiConfig.baseUrl === 'https://primary-openai.example/v1') {
        throw new Error('primary temporary outage');
      }
      return { content: 'same provider fallback ok', provider: kimiConfig.provider, model: kimiConfig.model };
    },
    {},
    { kimiConfig: cfg, timeoutMs: 5000 },
  );

  assert.equal(out.content, 'same provider fallback ok');
  assert.deepEqual(seen.map((item) => item.baseUrl), ['https://primary-openai.example/v1', 'https://fallback-openai.example/v1']);
  assert.equal(seen[1].apiKey, 'sk-fallback-same-provider-123456');
});

test('callModelResilient reports exhausted fallback chains with redacted layer errors', async () => {
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-EXHAUSTSECRET1234567890',
    baseUrl: 'https://primary-exhaust.example/v1',
    model: 'primary-exhaust',
    fallbacks: [
      { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11435/v1', model: 'local-exhaust' },
    ],
  };

  await assert.rejects(
    () => callModelResilient(
      async ({ kimiConfig }) => {
        throw new Error(`failed ${kimiConfig.provider} sk-EXHAUSTSECRET1234567890`);
      },
      {},
      { kimiConfig: cfg, timeoutMs: 5000 },
    ),
    (err) => err.code === 'FALLBACK_EXHAUSTED' && !err.message.includes('sk-EXHAUSTSECRET'),
  );
});

test('callModelResilient does not fall back on auth or 4xx configuration errors', async () => {
  const seen = [];
  const events = [];
  const cfg = {
    provider: 'openai',
    apiKey: 'sk-AUTHSECRET1234567890',
    baseUrl: 'https://auth.example/v1',
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
      {},
      { kimiConfig: cfg, timeoutMs: 5000, onFallback: (event) => events.push(event) },
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
  const leaky = friendlyAgentError({ message: 'failed for key sk-LIVEKEY1234567890abc' }, {});
  assert.ok(!leaky.includes('sk-LIVEKEY'), 'error message must be redacted');
});
