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
  resetWeakCredentialFallbackWarning,
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
    /empty key part/,
  );
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

test('AES-GCM protector warns once when falling back to the weak host/user/home-derived key', () => {
  const original = process.env.KCW_CREDENTIAL_KEY;
  delete process.env.KCW_CREDENTIAL_KEY;
  const originalWarn = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => { calls.push(args); };
  try {
    resetWeakCredentialFallbackWarning();
    createAesGcmProtector({}); // 无 keyMaterial、无 env → 走弱 fallback → 应警告一次
    createAesGcmProtector({}); // 再次落到同一弱 fallback → 不应重复刷屏
    assert.equal(calls.length, 1, 'weak fallback must warn exactly once, not per-call');
    assert.match(String(calls[0]?.[0]), /KCW_CREDENTIAL_KEY/);

    // 显式传 keyMaterial 不算弱 fallback,不应触发警告。
    resetWeakCredentialFallbackWarning();
    createAesGcmProtector({ keyMaterial: 'explicit-key' });
    assert.equal(calls.length, 1, 'explicit keyMaterial must not trigger the weak-fallback warning');
  } finally {
    console.warn = originalWarn;
    if (original !== undefined) process.env.KCW_CREDENTIAL_KEY = original;
    resetWeakCredentialFallbackWarning();
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
  const protector = createDefaultCredentialProtector();
  assert.equal(typeof protector.protect, 'function');
  assert.equal(typeof protector.unprotect, 'function');
});

test('credential summaries whitelist account fields, normalize scopes, and fill safe defaults', () => {
  const summary = summarizeCredential(
    { provider: 'github', accountId: '', tenantId: '', userId: null },
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
  assert.equal(summary.accountId, 'octocat');
  assert.equal(summary.tenantId, 'tenant_local');
  assert.equal(summary.userId, 'user_local');
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
