import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCredentialStore,
  type CredentialIdentity,
  type CredentialProtector,
} from '../src/security/credential-store.js';
import {
  credentialSummaryDto,
  writeCredentialDiskFile,
} from '../src/security/credential-persistence.js';

const IDENTITY: CredentialIdentity = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  provider: 'github',
  accountId: 'octocat',
};

function tmpFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-credential-persistence-'));
  return path.join(directory, 'credentials.json');
}

function protector(): CredentialProtector {
  return {
    protect(value: unknown): string {
      return 'sealed:' + Buffer.from(String(value), 'utf8').toString('base64');
    },
    unprotect(value: unknown): string {
      return Buffer.from(String(value).slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

function summary(scopes: unknown): Record<string, unknown> {
  return {
    provider: 'github',
    accountId: 'octocat',
    tenantId: 'tenant-a',
    userId: 'user-a',
    scopes,
    account: null,
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

function rawBytes(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

test('credential summary scope decoding never executes array iterators or index accessors', () => {
  let iteratorCalls = 0;
  const customIterator = ['read:user'];
  Object.defineProperty(customIterator, Symbol.iterator, {
    configurable: true,
    value() {
      iteratorCalls += 1;
      return [][Symbol.iterator]();
    },
  });
  assert.equal(credentialSummaryDto(summary(customIterator)), null);
  assert.equal(iteratorCalls, 0);

  let getterCalls = 0;
  const accessorScope = ['read:user'];
  Object.defineProperty(accessorScope, '0', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'read:user';
    },
  });
  assert.equal(credentialSummaryDto(summary(accessorScope)), null);
  assert.equal(getterCalls, 0);
});

test('credential atomic writer does not delete a pre-existing temporary-file collision', () => {
  const filePath = tmpFile();
  const originalBytes = Buffer.from('existing-destination-bytes', 'utf8');
  const collisionBytes = Buffer.from('pre-existing-temp-owner', 'utf8');
  fs.writeFileSync(filePath, originalBytes);

  const originalOpenSync = fs.openSync;
  let collisionPath = '';
  fs.openSync = ((
    target: string,
    flags: string | number,
    mode?: number,
  ) => {
    collisionPath = target;
    const collisionDescriptor = originalOpenSync(collisionPath, 'wx', 0o600);
    try {
      const writeDescriptor = fs.writeFileSync as unknown as (
        descriptor: number,
        data: Buffer,
      ) => void;
      writeDescriptor(collisionDescriptor, collisionBytes);
    } finally {
      fs.closeSync(collisionDescriptor);
    }
    return originalOpenSync(target, flags, mode);
  }) as typeof fs.openSync;

  try {
    assert.throws(
      () => writeCredentialDiskFile(filePath, { schemaVersion: 1, entries: {} }),
      (error: unknown) => (
        typeof error === 'object'
        && error !== null
        && (error as { code?: unknown }).code === 'EEXIST'
      ),
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.ok(collisionPath);
  assert.equal(fs.existsSync(collisionPath), true);
  assert.deepEqual(rawBytes(collisionPath), collisionBytes);
  assert.deepEqual(rawBytes(filePath), originalBytes);
});

test('credential put rejects malformed disk roots without changing their bytes', () => {
  const malformedRoots: unknown[] = [
    [],
    { schemaVersion: 2, entries: {} },
    { schemaVersion: 1, entries: null },
    { schemaVersion: 1, entries: {}, unexpected: true },
  ];

  for (const malformed of malformedRoots) {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, JSON.stringify(malformed) + '\n', 'utf8');
    const before = rawBytes(filePath);
    const store = createCredentialStore({ filePath, protector: protector() });

    assert.throws(
      () => store.put(IDENTITY, { accessToken: 'replacement-token' }),
      /credential disk file.*invalid/i,
    );
    assert.deepEqual(rawBytes(filePath), before);
  }
});

test('credential put rejects corrupt entries and tuple/legacy conflicts without changing bytes', () => {
  for (const corruption of ['same-tuple', 'unrelated', 'legacy-conflict'] as const) {
    const filePath = tmpFile();
    const store = createCredentialStore({ filePath, protector: protector() });
    store.put(IDENTITY, { accessToken: 'original-token' });
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      schemaVersion: 1;
      entries: Record<string, { sealed: string; summary: Record<string, unknown> }>;
    };
    const tupleKey = Object.keys(persisted.entries)[0];
    assert.ok(tupleKey);
    const entry = persisted.entries[tupleKey];
    assert.ok(entry);

    if (corruption === 'same-tuple') {
      entry.sealed = '';
    } else if (corruption === 'unrelated') {
      persisted.entries.invalid = { sealed: '', summary: {} };
    } else {
      const legacyKey = [
        IDENTITY.tenantId,
        IDENTITY.userId,
        IDENTITY.provider,
        IDENTITY.accountId,
      ].map((part) => encodeURIComponent(String(part))).join('/');
      persisted.entries[legacyKey] = {
        sealed: entry.sealed + '-different',
        summary: { ...entry.summary },
      };
    }
    fs.writeFileSync(filePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
    const before = rawBytes(filePath);

    assert.throws(
      () => store.put(IDENTITY, { accessToken: 'replacement-token' }),
      /credential (?:disk file|entry|key).*?(?:invalid|conflict)/i,
    );
    assert.deepEqual(rawBytes(filePath), before);
  }
});

test('credential deletions reject unrelated corrupt entries before changing disk bytes', () => {
  for (const operation of ['delete', 'deleteMany'] as const) {
    const filePath = tmpFile();
    const store = createCredentialStore({ filePath, protector: protector() });
    store.put(IDENTITY, { accessToken: 'delete-target' });
    store.put({ ...IDENTITY, accountId: 'keep' }, { accessToken: 'keep-token' });
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      schemaVersion: 1;
      entries: Record<string, unknown>;
    };
    persisted.entries.invalid = { sealed: '', summary: {} };
    fs.writeFileSync(filePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
    const before = rawBytes(filePath);

    assert.throws(
      () => operation === 'delete'
        ? store.delete(IDENTITY)
        : store.deleteMany(IDENTITY),
      /credential entry.*invalid/i,
    );
    assert.deepEqual(rawBytes(filePath), before);
  }
});

test('credential list refuses legacy migration when another entry is corrupt', () => {
  const filePath = tmpFile();
  const identity = { ...IDENTITY, accountId: 'octo/cat' };
  const store = createCredentialStore({ filePath, protector: protector() });
  store.put(identity, { accessToken: 'migration-target' });
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    schemaVersion: 1;
    entries: Record<string, unknown>;
  };
  const tupleKey = Object.keys(persisted.entries)[0];
  assert.ok(tupleKey);
  const entry = persisted.entries[tupleKey];
  const legacyKey = [
    identity.tenantId,
    identity.userId,
    identity.provider,
    identity.accountId,
  ].map((part) => encodeURIComponent(String(part))).join('/');
  persisted.entries[legacyKey] = entry;
  Reflect.deleteProperty(persisted.entries, tupleKey);
  persisted.entries.invalid = { sealed: '', summary: {} };
  fs.writeFileSync(filePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
  const before = rawBytes(filePath);

  assert.throws(() => store.list({ tenantId: identity.tenantId }), /credential entry.*invalid/i);
  assert.deepEqual(rawBytes(filePath), before);
});
