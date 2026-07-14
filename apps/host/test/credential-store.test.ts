import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAesGcmProtector,
  createCredentialStore,
  createDefaultCredentialProtector,
  createDpapiProtector,
} from '../src/security/credential-store.js';
import { summarizeCredential } from '../src/security/credential-summary.js';
import type { CredentialProtector } from '../src/security/credential-store.js';

type JsonRecord = Record<string, unknown>;

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-credentials-'));
  return path.join(dir, 'credentials.json');
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as JsonRecord;
}

function testProtector(): CredentialProtector {
  return {
    protect(plainText: unknown): string {
      return `sealed:${Buffer.from(String(plainText), 'utf8').toString('base64')}`;
    },
    unprotect(sealedText: unknown): string {
      assert.ok(String(sealedText).startsWith('sealed:'));
      return Buffer.from(String(sealedText).slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

function legacyCredentialKey(identity: {
  tenantId: string;
  userId: string;
  provider: string;
  accountId: string;
}): string {
  return [identity.tenantId, identity.userId, identity.provider, identity.accountId]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function moveOnlyCredentialToLegacyKey(filePath: string, legacyKey: string): void {
  const persisted = requireJsonRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')), 'credential file');
  const entries = requireJsonRecord(persisted.entries, 'credential entries');
  const current = Object.entries(entries)[0];
  assert.ok(current);
  const [currentKey, entry] = current;
  entries[legacyKey] = entry;
  Reflect.deleteProperty(entries, currentKey);
  fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
}

test('credential get migrates a schemaVersion 1 URL key to the tuple key', () => {
  const filePath = tmpFile();
  const identity = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    provider: 'github',
    accountId: 'octo/cat',
  };
  const legacyKey = legacyCredentialKey(identity);
  const store = createCredentialStore({ filePath, protector: testProtector() });
  store.put(identity, { accessToken: 'legacy-test-token' });
  moveOnlyCredentialToLegacyKey(filePath, legacyKey);

  assert.equal(store.get(identity)?.accessToken, 'legacy-test-token');

  const persisted = requireJsonRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')), 'migrated file');
  const entries = requireJsonRecord(persisted.entries, 'migrated entries');
  assert.equal(Object.hasOwn(entries, legacyKey), false);
  assert.deepEqual(JSON.parse(Object.keys(entries)[0] || ''), [
    'identity-scope:v1',
    'tenant-a',
    'user-a',
    'credential',
    'github',
    'octo/cat',
  ]);
});

test('credential store seals OAuth tokens on disk and returns redacted summaries', () => {
  const filePath = tmpFile();
  const store = createCredentialStore({ filePath, protector: testProtector() });
  const token = 'gho_SECRET_TOKEN_1234567890';

  const summary = store.put({
    tenantId: 'tenant-a',
    userId: 'user-a',
    provider: 'github',
    accountId: 'octocat',
  }, {
    accessToken: token,
    tokenType: 'bearer',
    scope: 'read:user repo',
    account: { login: 'octocat', id: 1 },
  });

  assert.equal(summary.provider, 'github');
  assert.equal(summary.accountId, 'octocat');
  assert.deepEqual(summary.scopes, ['read:user', 'repo']);
  assert.equal(JSON.stringify(summary).includes(token), false);
  assert.equal(fs.readFileSync(filePath, 'utf8').includes(token), false);

  const loaded = requireJsonRecord(store.get({
    tenantId: 'tenant-a',
    userId: 'user-a',
    provider: 'github',
    accountId: 'octocat',
  }), 'loaded credential');
  assert.equal(loaded.accessToken, token);
  assert.deepEqual(loaded.account, { login: 'octocat', id: 1 });

  const listed = store.list({ tenantId: 'tenant-a', userId: 'user-a', provider: 'github' });
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(token), false);
});

test('credential store can revoke a provider account without leaking old secrets', () => {
  const filePath = tmpFile();
  const store = createCredentialStore({ filePath, protector: testProtector() });
  store.put({ tenantId: 't', userId: 'u', provider: 'github', accountId: 'octocat' }, { accessToken: 'token-a' });
  store.put({ tenantId: 't', userId: 'u', provider: 'github', accountId: 'hubot' }, { accessToken: 'token-b' });

  assert.equal(store.delete({ tenantId: 't', userId: 'u', provider: 'github', accountId: 'octocat' }), true);
  assert.equal(store.get({ tenantId: 't', userId: 'u', provider: 'github', accountId: 'octocat' }), null);
  assert.equal(store.list({ tenantId: 't', userId: 'u', provider: 'github' }).length, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('token-a'), false);
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('token-b'), false);
});

test('credential store validates identity inputs and tolerates malformed entry files', () => {
  assert.throws(() => createCredentialStore(), /filePath is required/);

  const filePath = tmpFile();
  fs.writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 1, entries: null })}\n`, 'utf8');
  const store = createCredentialStore({ filePath, protector: testProtector() });
  assert.deepEqual(store.list(), []);
  assert.equal(store.get({ tenantId: 't', userId: 'u', provider: 'github', accountId: 'missing' }), null);
  assert.equal(store.delete({ tenantId: 't', userId: 'u', provider: 'github', accountId: 'missing' }), false);

  assert.throws(
    () => store.put({ tenantId: 't', userId: 'u', provider: '', accountId: 'octocat' }, { accessToken: 'token' }),
    /credential provider/i,
  );
});

test('credential store rejects persisted summaries with undeclared fields', () => {
  const filePath = tmpFile();
  const store = createCredentialStore({ filePath, protector: testProtector() });
  store.put(
    { tenantId: 'tenant-a', userId: 'user-a', provider: 'github', accountId: 'octocat' },
    { accessToken: 'test-token' },
  );

  const persisted = requireJsonRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')), 'credential file');
  const entries = requireJsonRecord(persisted.entries, 'credential entries');
  const entry = requireJsonRecord(Object.values(entries)[0], 'credential entry');
  const summary = requireJsonRecord(entry.summary, 'credential summary');
  summary.accessToken = 'test-secret-marker';
  fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  const listed = store.list({ tenantId: 'tenant-a', userId: 'user-a' });
  assert.deepEqual(listed, []);
  assert.equal(JSON.stringify(listed).includes('test-secret-marker'), false);
});

test('credential store rejects tuple keys whose persisted owner summary disagrees', () => {
  const filePath = tmpFile();
  const store = createCredentialStore({ filePath, protector: testProtector() });
  const identity = { tenantId: 'tenant-a', userId: 'user-a', provider: 'github', accountId: 'octocat' };
  store.put(identity, { accessToken: 'test-owner-secret' });

  const persisted = requireJsonRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')), 'credential file');
  const entries = requireJsonRecord(persisted.entries, 'credential entries');
  const entry = requireJsonRecord(Object.values(entries)[0], 'credential entry');
  const summary = requireJsonRecord(entry.summary, 'credential summary');
  summary.userId = 'user-b';
  fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  assert.deepEqual(store.list({ tenantId: 'tenant-a', userId: 'user-a' }), []);
  assert.equal(store.get(identity), null);
  assert.equal(store.deleteMany({ tenantId: 'tenant-a', userId: 'user-a' }), 0);
});

test('credential store rejects non-object or dangerous decrypted JSON payloads', () => {
  const invalidPayloads = [
    'null',
    '[]',
    '{"__proto__":{"polluted":true}}',
    '{"nested":{"constructor":"test-secret-marker"}}',
  ];
  for (const plainText of invalidPayloads) {
    const filePath = tmpFile();
    const protector: CredentialProtector = {
      protect: () => 'sealed:test-payload',
      unprotect: () => plainText,
    };
    const store = createCredentialStore({ filePath, protector });
    const identity = { tenantId: 'tenant-a', userId: 'user-a', provider: 'github', accountId: 'octocat' };
    store.put(identity, { accessToken: 'test-token' });
    assert.throws(() => store.get(identity), /credential payload.*(?:corrupt|invalid)/i);
  }
});

test('credential exact operations require a canonical owner and raw bounded key parts', () => {
  const store = createCredentialStore({ filePath: tmpFile(), protector: testProtector() });
  const valid = { tenantId: 'tenant-a', userId: 'user-a', provider: 'github', accountId: 'octocat' };
  store.put(valid, { accessToken: 'token' });

  const invalidIdentities = [
    { userId: 'user-a', provider: 'github', accountId: 'octocat' },
    { tenantId: 'tenant-a', provider: 'github', accountId: 'octocat' },
    { tenantId: ' tenant-a', userId: 'user-a', provider: 'github', accountId: 'octocat' },
    { tenantId: 'tenant-a', userId: 'user-a', provider: ' github', accountId: 'octocat' },
    { tenantId: 'tenant-a', userId: 'user-a', provider: 'github', accountId: ' octocat' },
  ];
  for (const identity of invalidIdentities) {
    assert.throws(() => store.put(identity, { accessToken: 'bad' }), /credential|canonical/i);
    assert.throws(() => store.get(identity), /credential|canonical/i);
    assert.throws(() => store.delete(identity), /credential|canonical/i);
  }

  const defaultAccount = store.put(
    { tenantId: 'tenant-a', userId: 'user-a', provider: 'slack' },
    { accessToken: 'token-default', account: { login: 'must-not-become-key' } },
  );
  assert.equal(defaultAccount.accountId, 'default');
  const explicitUndefined = Object.defineProperty(
    { tenantId: 'tenant-a', userId: 'user-a', provider: 'github' },
    'accountId',
    { enumerable: true, value: undefined },
  );
  assert.throws(() => store.get(explicitUndefined), /credential accountId/i);
});

test('credential filters preserve legal partial filters and reject malformed provided fields', () => {
  const store = createCredentialStore({ filePath: tmpFile(), protector: testProtector() });
  store.put({ tenantId: 't', userId: 'alice', provider: 'github', accountId: 'one' }, { accessToken: 'one' });
  store.put({ tenantId: 't', userId: 'bob', provider: 'slack', accountId: 'two' }, { accessToken: 'two' });
  assert.equal(store.list({ tenantId: 't' }).length, 2);
  assert.equal(store.list({ userId: 'alice' }).length, 1);

  const ownUndefined = Object.defineProperty({}, 'tenantId', { enumerable: true, value: undefined });
  for (const filter of [
    { tenantId: ' t' },
    { userId: 42 },
    { provider: ' github' },
    { accountId: '' },
    ownUndefined,
  ]) {
    assert.throws(() => store.list(filter), /credential|canonical/i);
    assert.throws(() => store.deleteMany(filter), /credential|canonical/i);
  }

  let getterCalled = false;
  const accessorFilter = Object.defineProperty({}, 'tenantId', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 't';
    },
  });
  assert.throws(() => store.list(accessorFilter), /credential|canonical/i);
  assert.equal(getterCalled, false);
});

test('credential store deleteMany revokes only the matching tenant/user/provider scope', () => {
  const filePath = tmpFile();
  const store = createCredentialStore({ filePath, protector: testProtector() });
  store.put({ tenantId: 't', userId: 'alice', provider: 'github', accountId: 'octocat' }, { accessToken: 'token-a' });
  store.put({ tenantId: 't', userId: 'bob', provider: 'github', accountId: 'hubot' }, { accessToken: 'token-b' });
  store.put({ tenantId: 't', userId: 'alice', provider: 'slack', accountId: 'workspace' }, { accessToken: 'token-c' });

  assert.equal(store.deleteMany({ tenantId: 't', userId: 'alice', provider: 'github' }), 1);
  assert.equal(store.get({ tenantId: 't', userId: 'alice', provider: 'github', accountId: 'octocat' }), null);
  assert.equal(store.list({ tenantId: 't' }).length, 2);
  assert.equal(store.list({ tenantId: 't', userId: 'bob', provider: 'github' }).length, 1);
  assert.equal(store.list({ tenantId: 't', userId: 'alice', provider: 'slack' }).length, 1);
  assert.equal(store.deleteMany({ tenantId: 't', userId: 'alice', provider: 'missing' }), 0);
});

test('credential store deleteMany honors accountId when revoking one provider account', () => {
  const filePath = tmpFile();
  const store = createCredentialStore({ filePath, protector: testProtector() });
  store.put({ tenantId: 't', userId: 'alice', provider: 'github', accountId: 'octocat' }, { accessToken: 'token-a' });
  store.put({ tenantId: 't', userId: 'alice', provider: 'github', accountId: 'hubot' }, { accessToken: 'token-b' });
  store.put({ tenantId: 't', userId: 'alice', provider: 'slack', accountId: 'workspace' }, { accessToken: 'token-c' });

  assert.equal(store.deleteMany({
    tenantId: 't',
    userId: 'alice',
    provider: 'github',
    accountId: 'octocat',
  }), 1);
  assert.equal(store.get({ tenantId: 't', userId: 'alice', provider: 'github', accountId: 'octocat' }), null);
  assert.equal(store.get({ tenantId: 't', userId: 'alice', provider: 'github', accountId: 'hubot' })?.accessToken, 'token-b');
  assert.equal(store.get({ tenantId: 't', userId: 'alice', provider: 'slack', accountId: 'workspace' })?.accessToken, 'token-c');
});

test('AES-GCM credential protector round-trips and rejects unsupported or tampered ciphertext', () => {
  const protector = createAesGcmProtector({ keyMaterial: 'test-key-material' });
  const sealed = protector.protect('plain-secret');
  assert.match(sealed, /^aesgcm:v1:/);
  assert.equal(protector.unprotect(sealed), 'plain-secret');
  assert.throws(() => protector.unprotect('sealed:legacy'), /Unsupported credential cipher text/);

  const parts = sealed.split(':');
  const encrypted = parts[4];
  assert.ok(encrypted);
  parts[4] = Buffer.from(`${encrypted}-tampered`, 'utf8').toString('base64');
  assert.throws(() => protector.unprotect(parts.join(':')), /authenticate|bad decrypt|Unsupported/i);
});

test('AES-GCM credential protector rejects incomplete ciphertext parts', () => {
  const protector = createAesGcmProtector({ keyMaterial: 'test-key-material' });

  assert.throws(() => protector.unprotect('aesgcm:v1:::payload'), /Unsupported credential cipher text/);
  assert.throws(() => protector.unprotect('aesgcm:v1:iv:tag'), /Unsupported credential cipher text/);
});

test('AES-GCM credential protector round-trips empty plaintext and rejects non-canonical parts', () => {
  const protector = createAesGcmProtector({ keyMaterial: 'test-key-material' });
  const emptySealed = protector.protect('');
  assert.match(emptySealed, /^aesgcm:v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:$/);
  assert.equal(protector.unprotect(emptySealed), '');

  const [, , iv, tag] = emptySealed.split(':');
  assert.ok(iv);
  assert.ok(tag);
  for (const invalid of [
    'aesgcm:v1:AA==:' + tag + ':',
    'aesgcm:v1:' + iv + ':AA==:',
    'aesgcm:v1:' + iv.slice(0, -1) + ':' + tag + ':',
    'aesgcm:v1:' + iv + ':' + tag + ':AA',
    'aesgcm:v1:' + iv + ':' + tag + ':!!!!',
  ]) {
    assert.throws(() => protector.unprotect(invalid), /Unsupported credential cipher text/);
  }
});

test('AES-GCM protector fails closed instead of deriving a key from public host metadata', () => {
  const originalAcw = process.env.ACW_CREDENTIAL_KEY;
  const originalKcw = process.env.KCW_CREDENTIAL_KEY;
  delete process.env.ACW_CREDENTIAL_KEY;
  delete process.env.KCW_CREDENTIAL_KEY;
  try {
    assert.throws(
      () => createAesGcmProtector({}),
      /ACW_CREDENTIAL_KEY.*required/i,
    );
    assert.doesNotThrow(() => createAesGcmProtector({ keyMaterial: 'explicit-test-key' }));
  } finally {
    if (originalAcw !== undefined) process.env.ACW_CREDENTIAL_KEY = originalAcw;
    if (originalKcw !== undefined) process.env.KCW_CREDENTIAL_KEY = originalKcw;
  }
});

test('AES-GCM protector reads the new ACW_CREDENTIAL_KEY env name and prefers it over the legacy KCW_CREDENTIAL_KEY', () => {
  const originalAcw = process.env.ACW_CREDENTIAL_KEY;
  const originalKcw = process.env.KCW_CREDENTIAL_KEY;
  try {
    process.env.ACW_CREDENTIAL_KEY = 'new-name-key-material-16bytes';
    delete process.env.KCW_CREDENTIAL_KEY;
    assert.doesNotThrow(() => createAesGcmProtector({}), 'new ACW_ name alone should satisfy the key requirement');

    process.env.KCW_CREDENTIAL_KEY = 'legacy-name-key-material-16bytes';
    const protectorWithBoth = createAesGcmProtector({});
    const protectorWithAcwOnly = (() => {
      delete process.env.KCW_CREDENTIAL_KEY;
      const p = createAesGcmProtector({});
      process.env.KCW_CREDENTIAL_KEY = 'legacy-name-key-material-16bytes';
      return p;
    })();
    const sealed = protectorWithBoth.protect('secret-value');
    assert.equal(protectorWithAcwOnly.unprotect(sealed), 'secret-value', 'ACW_ name must win when both env names are set');
  } finally {
    if (originalAcw === undefined) delete process.env.ACW_CREDENTIAL_KEY;
    else process.env.ACW_CREDENTIAL_KEY = originalAcw;
    if (originalKcw === undefined) delete process.env.KCW_CREDENTIAL_KEY;
    else process.env.KCW_CREDENTIAL_KEY = originalKcw;
  }
});

test('DPAPI credential protector uses stdin, timeout, hidden window, and validates prefixes', () => {
  const originalExecFileSync = childProcess.execFileSync;
  const calls: Array<{
    file: string;
    args: readonly string[];
    options: {
      input?: string | Buffer;
      encoding?: string;
      windowsHide?: boolean;
      timeout?: number;
    };
  }> = [];

  childProcess.execFileSync = ((file: string, args: readonly string[], options: {
    input?: string | Buffer;
    encoding?: string;
    windowsHide?: boolean;
    timeout?: number;
  }) => {
    calls.push({ file, args, options });
    const script = String(args.at(-1) || '');
    if (script.includes('ProtectedData]::Protect')) {
      assert.equal(Buffer.from(String(options.input || ''), 'base64').toString('utf8'), 'plain-secret');
      return 'sealed-base64\n';
    }
    assert.equal(options.input, 'sealed-base64');
    return Buffer.from('plain-secret', 'utf8').toString('base64');
  }) as typeof childProcess.execFileSync;

  try {
    const protector = createDpapiProtector();
    assert.equal(protector.protect('plain-secret'), 'dpapi:v1:sealed-base64');
    assert.equal(protector.unprotect('dpapi:v1:sealed-base64'), 'plain-secret');
    assert.throws(() => protector.unprotect('aesgcm:v1:sealed-base64'), /Unsupported credential cipher text/);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
  }

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.file.endsWith('powershell.exe'));
    assert.deepEqual(call.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']);
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 5000);
  }
});

test('default credential protector can be created for the current platform', () => {
  const original = process.env.KCW_CREDENTIAL_KEY;
  process.env.KCW_CREDENTIAL_KEY = 'explicit-test-key';
  try {
    const protector = createDefaultCredentialProtector();
    assert.equal(typeof protector.protect, 'function');
    assert.equal(typeof protector.unprotect, 'function');
  } finally {
    if (original === undefined) delete process.env.KCW_CREDENTIAL_KEY;
    else process.env.KCW_CREDENTIAL_KEY = original;
  }
});

test('credential summaries whitelist account fields and preserve canonical identity', () => {
  const summary = summarizeCredential(
    { provider: 'github', tenantId: 'tenant-a', userId: 'user-a' },
    {
      scopes: [' repo ', '', 'read:user'],
      accessToken: 'token-must-not-leak',
      refreshToken: 'refresh-must-not-leak',
      account: {
        login: 'octocat',
        id: 1,
        name: 'Mona',
        email: 'mona@example.test',
        accessToken: 'account-token-must-not-leak',
        private_note: 'hidden',
      },
    },
  );

  assert.equal(summary.provider, 'github');
  assert.equal(summary.accountId, 'default');
  assert.equal(summary.tenantId, 'tenant-a');
  assert.equal(summary.userId, 'user-a');
  assert.deepEqual(summary.scopes, ['repo', 'read:user']);
  assert.deepEqual(summary.account, {
    login: 'octocat',
    id: 1,
    name: 'Mona',
    email: 'mona@example.test',
  });
  assert.ok(!Number.isNaN(Date.parse(summary.updatedAt)));
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('token-must-not-leak'), false);
  assert.equal(serialized.includes('refresh-must-not-leak'), false);
  assert.equal(serialized.includes('account-token-must-not-leak'), false);
  assert.equal(serialized.includes('private_note'), false);
});

test('credential summaries parse space-separated scopes and drop non-object accounts', () => {
  const summary = summarizeCredential(
    { provider: 'slack', accountId: 'workspace-1', tenantId: 'tenant-1', userId: 'user-1' },
    { scope: 'channels:read  chat:write   ', account: 'not-an-object' },
  );

  assert.deepEqual(summary.scopes, ['channels:read', 'chat:write']);
  assert.equal(summary.account, null);
  assert.equal(summary.accountId, 'workspace-1');
  assert.equal(summary.tenantId, 'tenant-1');
  assert.equal(summary.userId, 'user-1');
});
