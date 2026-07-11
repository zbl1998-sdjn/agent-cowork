import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCustomRecipeStore } from '../src/recipes/custom-recipes.js';

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-custom-recipe-owner-'));
  const storePath = path.join(root, 'custom-recipes.json');
  return { storePath, store: createCustomRecipeStore({ storePath }) };
}

test('custom recipes default to local only when scope is omitted', () => {
  const { store } = createStore();
  const saved = store.save({ id: 'local-recipe', name: 'Local', redacted: true });
  assert.equal(saved.tenantId, 'tenant_local');
  assert.equal(saved.userId, 'user_local');
  assert.equal(store.get('local-recipe')?.id, 'local-recipe');

  for (const scope of [
    {},
    { tenantId: 'tenant_a' },
    { userId: 'user_a' },
    { tenantId: ' tenant_a', userId: 'user_a' },
    { tenantId: undefined, userId: 'user_a' },
  ]) {
    assert.throws(() => store.list(scope), /canonical tenantId and userId are required/i);
    assert.throws(
      () => store.save({ id: 'bad-owner', name: 'Bad', redacted: true }, scope),
      /canonical tenantId and userId are required/i,
    );
  }
});

test('custom recipes fail closed for invalid persisted owners', () => {
  const { store, storePath } = createStore();
  const scope = { tenantId: 'tenant_a', userId: 'user_a' };
  const valid = store.save({ id: 'valid-recipe', name: 'Valid', redacted: true }, scope);
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { recipes: unknown[] };
  parsed.recipes.push({ ...valid, id: 'trimmed-owner', tenantId: ' tenant_a' });
  parsed.recipes.push({ ...valid, id: 'missing-owner', userId: undefined });
  fs.writeFileSync(storePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  assert.deepEqual(store.list(scope).map((recipe) => recipe.id), ['valid-recipe']);
  assert.equal(store.get('trimmed-owner', scope), null);
  assert.equal(store.get('missing-owner', scope), null);
});

test('custom recipes hide incomplete or over-specified persisted records and refuse to overwrite them', () => {
  const { store, storePath } = createStore();
  const scope = { tenantId: 'tenant_a', userId: 'user_a' };
  store.save({ id: 'valid-recipe', name: 'Valid', redacted: true }, scope);
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { recipes: unknown[] };
  parsed.recipes.push({
    id: 'incomplete-recipe',
    tenantId: 'tenant_a',
    userId: 'user_a',
    custom: true,
    redacted: true,
    accessToken: 'test-secret-marker',
  });
  fs.writeFileSync(storePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  const before = fs.readFileSync(storePath);

  const listed = store.list(scope);
  assert.deepEqual(listed.map((recipe) => recipe.id), ['valid-recipe']);
  assert.equal(JSON.stringify(listed).includes('test-secret-marker'), false);
  assert.throws(
    () => store.save({ id: 'next-recipe', name: 'Next', redacted: true }, scope),
    /custom recipe store.*corrupt|refus/i,
  );
  assert.deepEqual(fs.readFileSync(storePath), before);
});

test('custom recipes treat duplicate owner and id tuples as corrupt without rewriting the file', () => {
  const { store, storePath } = createStore();
  const scope = { tenantId: 'tenant_a', userId: 'user_a' };
  store.save({ id: 'duplicate-recipe', name: 'Original', redacted: true }, scope);
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { recipes: unknown[] };
  const original = parsed.recipes[0] as Record<string, unknown>;
  parsed.recipes.push({ ...original, name: 'Duplicate' });
  fs.writeFileSync(storePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  const before = fs.readFileSync(storePath);

  assert.deepEqual(store.list(scope), []);
  assert.equal(store.get('duplicate-recipe', scope), null);
  assert.throws(
    () => store.save({ id: 'another-recipe', name: 'Another', redacted: true }, scope),
    /custom recipe store.*corrupt|duplicate|refus/i,
  );
  assert.deepEqual(fs.readFileSync(storePath), before);
});

test('custom recipe identity validation does not execute accessors', () => {
  const { store } = createStore();
  let getterCalled = false;
  const scope = Object.defineProperty({ userId: 'user_a' }, 'tenantId', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'tenant_a';
    },
  });
  assert.throws(() => store.list(scope), /canonical tenantId and userId are required/i);
  assert.equal(getterCalled, false);
});

test('custom recipe save sanitizes every returned string and nested JSON field', () => {
  const { store, storePath } = createStore();
  const scope = { tenantId: 'tenant_a', userId: 'user_a' };
  const secret = 'test-secret-marker';

  const saved = store.save({
    id: 'dlp-recipe',
    name: `Authorization: Bearer ${secret}`,
    description: `password=${secret}`,
    output: `cookie=${secret}`,
    prompt: `accessToken=${secret}`,
    format: { kind: 'markdown', body: `clientSecret=${secret}` },
    steps: [{
      tool: `token=${secret}`,
      status: `apiKey=${secret}`,
      args: { nested: { accessToken: secret } },
      result: { credential: secret },
      summary: { text: `secret=${secret}` },
    }],
    artifacts: [{
      path: `private-key=${secret}`,
      kind: `set-cookie=${secret}`,
      source: { password: secret },
    }],
    redacted: true,
  }, scope);

  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.deepEqual(saved.steps[0]?.args, { nested: { accessToken: '[REDACTED]' } });
  assert.deepEqual(saved.steps[0]?.result, { credential: '[REDACTED]' });
  assert.deepEqual(saved.artifacts[0]?.source, { password: '[REDACTED]' });
  assert.equal(fs.readFileSync(storePath, 'utf8').includes(secret), false);
  assert.equal(JSON.stringify(store.get('dlp-recipe', scope)).includes(secret), false);
});

test('custom recipes hide persisted strings that are not already fully redacted', () => {
  const { store, storePath } = createStore();
  const scope = { tenantId: 'tenant_a', userId: 'user_a' };
  store.save({
    id: 'stored-dlp',
    name: 'Stored DLP',
    steps: [{ tool: 'safe.tool', args: { accessToken: '[REDACTED]' } }],
    redacted: true,
  }, scope);
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
    recipes: Array<Record<string, unknown>>;
  };
  const stored = parsed.recipes[0];
  assert.ok(stored);
  stored.prompt = 'accessToken=test-secret-marker';
  stored.steps = [{ index: 0, tool: 'safe.tool', args: { accessToken: 'test-secret-marker' } }];
  fs.writeFileSync(storePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  const before = fs.readFileSync(storePath);

  assert.deepEqual(store.list(scope), []);
  assert.equal(store.get('stored-dlp', scope), null);
  assert.throws(
    () => store.save({ id: 'next', name: 'Next', redacted: true }, scope),
    /corrupt|refus/i,
  );
  assert.deepEqual(fs.readFileSync(storePath), before);
});

test('custom recipe save rejects an empty step tool before changing store bytes', () => {
  const { store, storePath } = createStore();
  const scope = { tenantId: 'tenant_a', userId: 'user_a' };
  store.save({ id: 'baseline', name: 'Baseline', redacted: true }, scope);
  const before = fs.readFileSync(storePath);

  assert.throws(
    () => store.save({
      id: 'empty-tool',
      name: 'Empty tool',
      steps: [{ tool: '   ', args: { safe: true } }],
      redacted: true,
    }, scope),
    /invalid|plain json/i,
  );
  assert.deepEqual(fs.readFileSync(storePath), before);
});

test('custom recipe save rejects reflection hazards and bounded JSON violations before writing', () => {
  let proxyTraps = 0;
  let accessorCalls = 0;
  const proxy = new Proxy({ safe: true }, {
    get() { proxyTraps += 1; return true; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
  });
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() { accessorCalls += 1; return 'unsafe'; },
  });
  const symbolValue = { safe: true } as Record<PropertyKey, unknown>;
  symbolValue[Symbol('hidden')] = 'unsafe';
  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 20; index += 1) deep = { nested: deep };
  const manyNodes = Array.from({ length: 256 }, (_, row) => (
    Object.fromEntries(Array.from({ length: 16 }, (__, column) => [`k${row}_${column}`, column]))
  ));
  const invalidValues: unknown[] = [
    proxy,
    accessor,
    symbolValue,
    JSON.parse('{"__proto__":"unsafe"}'),
    Object.create(null),
    new Date(),
    deep,
    new Array(1),
    Array.from({ length: 257 }, () => null),
    Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, index])),
    'x'.repeat(16_385),
    manyNodes,
    Number.NaN,
  ];

  for (const [index, invalid] of invalidValues.entries()) {
    const { store, storePath } = createStore();
    const scope = { tenantId: 'tenant_a', userId: 'user_a' };
    store.save({ id: 'baseline', name: 'Baseline', redacted: true }, scope);
    const before = fs.readFileSync(storePath);
    assert.throws(
      () => store.save({
        id: `invalid-${index}`,
        name: 'Invalid JSON',
        steps: [{ tool: 'safe.tool', args: invalid }],
        artifacts: [{ path: 'out.txt', kind: 'file', source: invalid }],
        redacted: true,
      }, scope),
      /bounded plain JSON|invalid|safety limits/i,
    );
    assert.deepEqual(fs.readFileSync(storePath), before);
  }
  assert.equal(proxyTraps, 0);
  assert.equal(accessorCalls, 0);
});
