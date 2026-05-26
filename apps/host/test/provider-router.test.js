import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderRouter, orderProviderChain, runWithFallback } from '../src/kimi/provider/router.js';

test('orderProviderChain de-dupes and preserves order', () => {
  assert.deepEqual(orderProviderChain(['kimi', 'openai', 'kimi', 'anthropic']), ['kimi', 'openai', 'anthropic']);
});

test('orderProviderChain puts circuit-open providers last', () => {
  const open = new Set(['kimi']);
  assert.deepEqual(
    orderProviderChain(['kimi', 'openai', 'anthropic'], { isOpen: (n) => open.has(n) }),
    ['openai', 'anthropic', 'kimi'],
  );
});

test('orderProviderChain keeps same-provider candidates with distinct baseUrl or model', () => {
  const primary = { provider: 'openai', baseUrl: 'https://a.example/v1', model: 'gpt-a' };
  const fallback = { provider: 'openai', baseUrl: 'https://b.example/v1', model: 'gpt-a' };
  const duplicate = { provider: 'OPENAI', baseUrl: 'https://a.example/v1/', model: 'gpt-a' };
  assert.deepEqual(orderProviderChain([primary, fallback, duplicate]), [primary, fallback]);
});

test('runWithFallback returns the primary result when it succeeds', async () => {
  const out = await runWithFallback(['kimi', 'openai'], async (name) => `ok:${name}`);
  assert.equal(out.provider, 'kimi');
  assert.equal(out.result, 'ok:kimi');
  assert.equal(out.attempts, 1);
});

test('runWithFallback falls through to the next provider on failure', async () => {
  const out = await runWithFallback(['kimi', 'openai', 'anthropic'], async (name) => {
    if (name !== 'anthropic') throw new Error(`${name} down`);
    return 'recovered';
  });
  assert.equal(out.provider, 'anthropic');
  assert.equal(out.result, 'recovered');
  assert.equal(out.attempts, 3);
});

test('runWithFallback throws an aggregate error when all providers fail', async () => {
  await assert.rejects(
    () => runWithFallback(['kimi', 'openai'], async (name) => { throw new Error(`${name} boom`); }),
    (err) => {
      assert.match(err.message, /all providers failed/);
      assert.equal(err.attempts.length, 2);
      return true;
    },
  );
});

test('runWithFallback can stop on non-fallbackable errors', async () => {
  const tried = [];
  await assert.rejects(
    () => runWithFallback(
      ['openai', 'openai/local'],
      async (name) => { tried.push(name); throw new Error('OpenAI request failed with status 401'); },
      { shouldFallback: (err) => !/status 401/.test(err.message) },
    ),
    /status 401/,
  );
  assert.deepEqual(tried, ['openai']);
});

test('runWithFallback reports object candidates when falling through', async () => {
  const primary = { provider: 'openai', baseUrl: 'https://primary.example/v1', model: 'gpt-primary' };
  const fallback = { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local' };
  const events = [];
  const out = await runWithFallback(
    [primary, fallback],
    async (candidate) => {
      if (candidate === primary) throw new Error('temporary outage');
      return 'ok';
    },
    { onFallback: (event) => events.push(event) },
  );
  assert.equal(out.provider, fallback);
  assert.equal(out.result, 'ok');
  assert.equal(events[0].failed, primary);
  assert.equal(events[0].next, fallback);
});

test('runWithFallback tries circuit-open providers last', async () => {
  const tried = [];
  const open = new Set(['kimi']);
  const out = await runWithFallback(
    ['kimi', 'openai'],
    async (name) => { tried.push(name); return name; },
    { isOpen: (n) => open.has(n) },
  );
  assert.equal(out.provider, 'openai');
  assert.deepEqual(tried, ['openai']);
});

test('empty chain and missing runner are rejected', async () => {
  await assert.rejects(() => runWithFallback([], async () => 'x'), /chain is empty/);
  await assert.rejects(() => runWithFallback(['kimi'], null), /runner is required/);
});

test('createProviderRouter exposes order() and run()', async () => {
  const router = createProviderRouter({ chain: ['kimi', 'openai'] });
  assert.deepEqual(router.order(), ['kimi', 'openai']);
  const out = await router.run(async (name) => name.toUpperCase());
  assert.equal(out.result, 'KIMI');
});
