import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCustomRecipeStore } from '../src/recipes/custom-recipes.js';

const STORE_BYTE_LIMIT = 1_048_576;
const SCOPE = { tenantId: 'tenant_a', userId: 'user_a' };

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-custom-recipe-storage-'));
  const storePath = path.join(root, 'custom-recipes.json');
  return { root, storePath, store: createCustomRecipeStore({ storePath }) };
}

function replaceFsMethod(
  name: 'openSync' | 'renameSync',
  replacement: (...args: unknown[]) => unknown,
): () => void {
  const original = Reflect.get(fs, name);
  Reflect.set(fs, name, replacement);
  return () => { Reflect.set(fs, name, original); };
}

test('custom recipe writes ignore a pre-existing predictable legacy temp file', () => {
  const { store, storePath } = createStore();
  store.save({ id: 'baseline', name: 'Baseline', redacted: true }, SCOPE);
  const fixedNow = 1_700_000_000_000;
  const legacyTemp = `${storePath}.${process.pid}.${fixedNow}.tmp`;
  fs.writeFileSync(legacyTemp, 'attacker-controlled', 'utf8');
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    store.save({ id: 'next', name: 'Next', redacted: true }, SCOPE);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(fs.readFileSync(legacyTemp, 'utf8'), 'attacker-controlled');
  assert.equal(store.get('next', SCOPE)?.name, 'Next');
});

test('exclusive temp-file creation failure cannot overwrite the recipe store', () => {
  const { root, store, storePath } = createStore();
  store.save({ id: 'baseline', name: 'Baseline', redacted: true }, SCOPE);
  const before = fs.readFileSync(storePath);
  const originalOpen = fs.openSync;
  let openOptions: unknown;
  const restore = replaceFsMethod('openSync', (...args: unknown[]) => {
    const candidate = String(args[0]);
    const privatePrefix = path.join(root, `.${path.basename(storePath)}.`);
    if (candidate.startsWith(privatePrefix) && candidate.endsWith('.tmp')) {
      openOptions = { flag: args[1], mode: args[2] };
      if (args[1] === 'wx') {
        throw Object.assign(new Error('exclusive temp exists'), { code: 'EEXIST' });
      }
    }
    return Reflect.apply(originalOpen, fs, args);
  });
  try {
    assert.throws(
      () => store.save({ id: 'blocked', name: 'Blocked', redacted: true }, SCOPE),
      /exclusive temp exists/,
    );
  } finally {
    restore();
  }

  assert.deepEqual(openOptions, { flag: 'wx', mode: 0o600 });
  assert.deepEqual(fs.readFileSync(storePath), before);
});

test('failed recipe-store rename removes its exclusively created temp file', () => {
  const { root, store, storePath } = createStore();
  store.save({ id: 'baseline', name: 'Baseline', redacted: true }, SCOPE);
  const before = fs.readFileSync(storePath);
  const originalRename = fs.renameSync;
  const restore = replaceFsMethod('renameSync', (...args: unknown[]) => {
    const source = String(args[0]);
    const basename = path.basename(storePath);
    const privatePrefix = path.join(root, `.${basename}.`);
    if ((source.startsWith(privatePrefix) || source.startsWith(`${storePath}.`))
      && source.endsWith('.tmp')) {
      throw new Error('test rename failure');
    }
    return Reflect.apply(originalRename, fs, args);
  });
  try {
    assert.throws(
      () => store.save({ id: 'blocked', name: 'Blocked', redacted: true }, SCOPE),
      /test rename failure/,
    );
  } finally {
    restore();
  }

  const basename = path.basename(storePath);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => (
      (name.startsWith(`${basename}.`) || name.startsWith(`.${basename}.`))
      && name.endsWith('.tmp')
    )),
    [],
  );
  assert.deepEqual(fs.readFileSync(storePath), before);
});

test('oversized recipe stores are corrupt before parsing and cannot be overwritten', () => {
  const { store, storePath } = createStore();
  fs.writeFileSync(storePath, Buffer.alloc(STORE_BYTE_LIMIT + 1));
  const before = fs.readFileSync(storePath);

  assert.throws(() => store.list(SCOPE), /exceeds.*byte limit/i);
  assert.throws(
    () => store.save({ id: 'blocked', name: 'Blocked', redacted: true }, SCOPE),
    /exceeds.*byte limit/i,
  );
  assert.deepEqual(fs.readFileSync(storePath), before);
});

test('a save that would exceed the store byte limit leaves existing bytes unchanged', () => {
  const { store, storePath } = createStore();
  store.save({ id: 'baseline', name: 'Baseline', redacted: true }, SCOPE);
  const before = fs.readFileSync(storePath);
  const largeArgs = Object.fromEntries(
    Array.from({ length: 70 }, (_, index) => [`field${index}`, 'x'.repeat(16_000)]),
  );

  assert.throws(
    () => store.save({
      id: 'oversized',
      name: 'Oversized',
      steps: [{ tool: 'safe.tool', args: largeArgs }],
      redacted: true,
    }, SCOPE),
    /exceeds.*byte limit/i,
  );
  assert.deepEqual(fs.readFileSync(storePath), before);
});
