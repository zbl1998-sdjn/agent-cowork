import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyPersistedAgentModelConfig, persistModelConfig } from '../src/engine/config-store.js';
import { createCustomRecipeStore } from '../src/recipes/custom-recipes.js';
import {
  createCredentialStore,
  type CredentialProtector,
} from '../src/security/credential-store.js';

const OWNER = { tenantId: 'tenant-a', userId: 'user-a' };
const CREDENTIAL_IDENTITY = {
  ...OWNER,
  provider: 'github',
  accountId: 'octocat',
};

function protector(): CredentialProtector {
  return {
    protect(value: unknown): string {
      return `sealed:${Buffer.from(String(value), 'utf8').toString('base64')}`;
    },
    unprotect(value: unknown): string {
      return Buffer.from(String(value).slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

function tempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function replaceDirectory(directory: string): string {
  const displaced = `${directory}.displaced`;
  fs.renameSync(directory, displaced);
  fs.mkdirSync(directory);
  return displaced;
}

function replaceDirectoryWhenTemporaryFileOpens(directory: string): {
  restore(): void;
} {
  const displaced = `${directory}.displaced`;
  const original = fs.openSync;
  let replaced = false;
  Reflect.set(fs, 'openSync', (...args: unknown[]) => {
    const candidate = String(args[0]);
    if (!replaced && path.basename(candidate).startsWith('.') && candidate.endsWith('.tmp')) {
      replaced = true;
      fs.renameSync(directory, displaced);
      fs.mkdirSync(directory);
    }
    return Reflect.apply(original, fs, args);
  });
  return {
    restore(): void {
      Reflect.set(fs, 'openSync', original);
    },
  };
}

function createDirectoryJunction(target: string, linkPath: string): void {
  const symlinkSync = (fs as unknown as {
    symlinkSync(source: string, destination: string, type: 'junction'): void;
  }).symlinkSync;
  symlinkSync(target, linkPath, 'junction');
}

test('credential read-modify-write rejects an ordinary parent replacement', () => {
  const directory = tempDirectory('kcw-sensitive-credential-swap-');
  const filePath = path.join(directory, 'credentials.json');
  const store = createCredentialStore({ filePath, protector: protector() });
  store.put(CREDENTIAL_IDENTITY, { accessToken: 'original' });
  const originalBytes = fs.readFileSync(filePath);
  let displaced = '';
  const swappingProtector: CredentialProtector = {
    ...protector(),
    protect(value: unknown): string {
      displaced = replaceDirectory(directory);
      return protector().protect(value);
    },
  };
  const swappingStore = createCredentialStore({ filePath, protector: swappingProtector });
  assert.throws(
    () => swappingStore.put(CREDENTIAL_IDENTITY, { accessToken: 'replacement' }),
    /managed directory changed|managed path parent changed/i,
  );
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(fs.readFileSync(path.join(displaced, 'credentials.json')), originalBytes);
});

test('custom recipe save rejects an ordinary parent replacement after reading', () => {
  const directory = tempDirectory('kcw-sensitive-recipe-swap-');
  const filePath = path.join(directory, 'recipes.json');
  const store = createCustomRecipeStore({ storePath: filePath });
  store.save({ id: 'original', name: 'Original', redacted: true }, OWNER);
  const originalBytes = fs.readFileSync(filePath);
  const originalStringify = JSON.stringify;
  let displaced = '';
  Reflect.set(JSON, 'stringify', (...args: unknown[]) => {
    displaced = replaceDirectory(directory);
    Reflect.set(JSON, 'stringify', originalStringify);
    return Reflect.apply(originalStringify, JSON, args);
  });
  try {
    assert.throws(
      () => store.save({ id: 'replacement', name: 'Replacement', redacted: true }, OWNER),
      /managed directory changed|managed path parent changed/i,
    );
  } finally {
    Reflect.set(JSON, 'stringify', originalStringify);
  }
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(fs.readFileSync(path.join(displaced, 'recipes.json')), originalBytes);
});

test('Kimi config read rejects a symbolic-link file without reading its target', (t) => {
  const directory = tempDirectory('kcw-sensitive-kimi-read-link-');
  const outside = path.join(directory, 'outside.json');
  const filePath = path.join(directory, 'kimi.json');
  fs.writeFileSync(outside, JSON.stringify({ kimiApi: { provider: 'ollama', model: 'blocked' } }), 'utf8');
  try {
    fs.symlinkSync(outside, filePath, 'file');
  } catch (error) {
    t.skip(`file symlink unavailable: ${String(error)}`);
    return;
  }
  const target: Record<string, unknown> = {};
  assert.throws(
    () => applyPersistedAgentModelConfig(filePath, target),
    /symbolic link|junction|reparse point|managed/i,
  );
  assert.deepEqual(target, {});
});

test('Kimi config write rejects an ordinary parent replacement before publish', () => {
  const directory = tempDirectory('kcw-sensitive-kimi-write-swap-');
  const filePath = path.join(directory, 'kimi.json');
  const swap = replaceDirectoryWhenTemporaryFileOpens(directory);
  try {
    assert.throws(
      () => persistModelConfig(filePath, { provider: 'ollama', model: 'qwen3' }),
      /managed directory changed|managed path parent changed/i,
    );
  } finally {
    swap.restore();
  }
  assert.equal(fs.existsSync(filePath), false);
});

for (const surface of ['credential', 'recipe', 'kimi'] as const) {
  test(`${surface} storage rejects a junctioned parent without writing outside`, (t) => {
    const base = tempDirectory(`kcw-sensitive-${surface}-junction-`);
    const outside = path.join(base, 'outside');
    const managed = path.join(base, 'managed');
    fs.mkdirSync(outside);
    try {
      createDirectoryJunction(outside, managed);
    } catch (error) {
      t.skip(`junction unavailable: ${String(error)}`);
      return;
    }
    const filePath = path.join(managed, `${surface}.json`);
    const action = surface === 'credential'
      ? () => createCredentialStore({ filePath, protector: protector() })
        .put(CREDENTIAL_IDENTITY, { accessToken: 'blocked' })
      : surface === 'recipe'
        ? () => createCustomRecipeStore({ storePath: filePath })
          .save({ id: 'blocked', name: 'Blocked', redacted: true }, OWNER)
        : () => persistModelConfig(filePath, { provider: 'ollama', model: 'qwen3' });
    assert.throws(action, /symbolic link|junction|reparse point|managed directory/i);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}
