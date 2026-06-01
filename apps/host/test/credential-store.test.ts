import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCredentialStore } from '../src/security/credential-store.js';
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
