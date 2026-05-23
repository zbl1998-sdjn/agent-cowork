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

test('friendlyAgentError degrades known states and redacts everything else', () => {
  assert.match(friendlyAgentError({ code: 'CIRCUIT_OPEN' }, { traceId: 't1' }), /熔断/);
  assert.match(friendlyAgentError({ code: 'CIRCUIT_OPEN' }, { traceId: 't1' }), /t1/);
  assert.match(friendlyAgentError({ code: 'ETIMEDOUT' }, {}), /超时/);
  const leaky = friendlyAgentError({ message: 'failed for key sk-LIVEKEY1234567890abc' }, {});
  assert.ok(!leaky.includes('sk-LIVEKEY'), 'error message must be redacted');
});
