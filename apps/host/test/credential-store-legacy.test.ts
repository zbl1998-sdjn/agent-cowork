import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCredentialStore, type CredentialProtector } from '../src/security/credential-store.js';

type JsonRecord = Record<string, unknown>;
const IDENTITY = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  provider: 'github',
  accountId: 'octo/cat',
};

function temporaryFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-credential-legacy-')), 'credentials.json');
}

function protector(): CredentialProtector {
  return {
    protect(value: unknown): string {
      return `sealed:${Buffer.from(String(value), 'utf8').toString('base64')}`;
    },
    unprotect(value: unknown): string {
      const text = String(value);
      assert.ok(text.startsWith('sealed:'));
      return Buffer.from(text.slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as JsonRecord;
}

function legacyKey(identity = IDENTITY): string {
  return [identity.tenantId, identity.userId, identity.provider, identity.accountId]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function persistedEntries(filePath: string): JsonRecord {
  const file = record(JSON.parse(fs.readFileSync(filePath, 'utf8')), 'credential file');
  return record(file.entries, 'credential entries');
}

function writeEntries(filePath: string, entries: JsonRecord): void {
  fs.writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, 'utf8');
}

function duplicateCurrentAsLegacy(
  filePath: string,
  { conflicting = false }: { conflicting?: boolean } = {},
): { legacy: string; tuple: string } {
  const entries = persistedEntries(filePath);
  const tuple = Object.keys(entries)[0];
  assert.ok(tuple);
  const duplicate = structuredClone(record(entries[tuple], 'credential entry'));
  if (conflicting) {
    duplicate.sealed = protector().protect(JSON.stringify({ accessToken: 'fake-legacy-conflict' }));
  }
  const legacy = legacyKey();
  entries[legacy] = duplicate;
  writeEntries(filePath, entries);
  return { legacy, tuple };
}

test('credential list migrates a valid legacy key without re-encrypting its payload', () => {
  const filePath = temporaryFile();
  const store = createCredentialStore({ filePath, protector: protector() });
  store.put(IDENTITY, { accessToken: 'fake-list-legacy' });
  const entries = persistedEntries(filePath);
  const tuple = Object.keys(entries)[0];
  assert.ok(tuple);
  const sealed = record(entries[tuple], 'credential entry').sealed;
  entries[legacyKey()] = entries[tuple];
  Reflect.deleteProperty(entries, tuple);
  writeEntries(filePath, entries);

  assert.equal(store.list({ tenantId: 'tenant-a', userId: 'user-a' }).length, 1);

  const migrated = persistedEntries(filePath);
  assert.equal(Object.hasOwn(migrated, legacyKey()), false);
  assert.equal(record(Object.values(migrated)[0], 'migrated entry').sealed, sealed);
});

test('credential get deduplicates identical keys and fails closed on conflicting ciphertext', () => {
  const duplicateFile = temporaryFile();
  const duplicateStore = createCredentialStore({ filePath: duplicateFile, protector: protector() });
  duplicateStore.put(IDENTITY, { accessToken: 'fake-duplicate' });
  const duplicateKeys = duplicateCurrentAsLegacy(duplicateFile);
  assert.equal(duplicateStore.get(IDENTITY)?.accessToken, 'fake-duplicate');
  assert.equal(Object.hasOwn(persistedEntries(duplicateFile), duplicateKeys.legacy), false);

  const conflictFile = temporaryFile();
  const conflictStore = createCredentialStore({ filePath: conflictFile, protector: protector() });
  conflictStore.put(IDENTITY, { accessToken: 'fake-current-conflict' });
  duplicateCurrentAsLegacy(conflictFile, { conflicting: true });
  const before = fs.readFileSync(conflictFile);

  assert.throws(() => conflictStore.get(IDENTITY), /credential key conflict/i);
  assert.throws(() => conflictStore.list({ tenantId: 'tenant-a' }), /credential key conflict/i);
  assert.deepEqual(fs.readFileSync(conflictFile), before);
});

test('credential delete removes both tuple and legacy ciphertext for one identity', () => {
  const filePath = temporaryFile();
  const store = createCredentialStore({ filePath, protector: protector() });
  store.put(IDENTITY, { accessToken: 'fake-delete-current' });
  duplicateCurrentAsLegacy(filePath, { conflicting: true });

  assert.equal(store.delete(IDENTITY), true);
  assert.deepEqual(persistedEntries(filePath), {});
});

test('credential deleteMany removes duplicate legacy ciphertext and counts one identity', () => {
  const filePath = temporaryFile();
  const store = createCredentialStore({ filePath, protector: protector() });
  store.put(IDENTITY, { accessToken: 'fake-delete-many-current' });
  store.put({ ...IDENTITY, accountId: 'keep' }, { accessToken: 'fake-keep' });
  const duplicateKeys = duplicateCurrentAsLegacy(filePath, { conflicting: true });

  assert.equal(store.deleteMany({ ...IDENTITY }), 1);

  const remaining = persistedEntries(filePath);
  assert.equal(Object.hasOwn(remaining, duplicateKeys.tuple), false);
  assert.equal(Object.hasOwn(remaining, duplicateKeys.legacy), false);
  assert.equal(store.get({ ...IDENTITY, accountId: 'keep' })?.accessToken, 'fake-keep');
});
