import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCredentialStore,
  type CredentialProtector,
} from '../src/security/credential-store.js';
import { summarizeCredential } from '../src/security/credential-summary.js';
import { credentialSummaryDto } from '../src/security/credential-persistence.js';

const IDENTITY = {
  tenantId: 'tenant-dto',
  userId: 'user-dto',
  provider: 'github',
  accountId: 'account-dto',
};

function temporaryFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-credential-dto-')), 'credentials.json');
}

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

test('credential account summaries expose only bounded primitive fields without invoking accessors', () => {
  let getterCalled = false;
  const account = Object.defineProperties({
    id: 7,
    name: true,
    email: 'x'.repeat(1025),
  }, {
    login: {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'must-not-be-read';
      },
    },
    nested: {
      enumerable: true,
      value: { accessToken: 'fake-nested-sensitive-value' },
    },
  });

  const summary = summarizeCredential(IDENTITY, { account });

  assert.equal(getterCalled, false);
  assert.deepEqual(summary.account, { id: 7 });
  assert.equal(JSON.stringify(summary).includes('fake-nested-sensitive-value'), false);
  assert.equal(JSON.stringify(summary).includes('must-not-be-read'), false);
});

test('credential DTO boundaries reject revoked proxies without invoking proxy traps', () => {
  const revokedScopes = Proxy.revocable([], {});
  const revokedAccount = Proxy.revocable({}, {});
  revokedScopes.revoke();
  revokedAccount.revoke();

  const summary = summarizeCredential(IDENTITY, {
    account: revokedAccount.proxy,
    scopes: revokedScopes.proxy,
  });
  assert.equal(summary.account, null);
  assert.deepEqual(summary.scopes, []);
  assert.equal(credentialSummaryDto({
    ...summary,
    scopes: revokedScopes.proxy,
  }), null);
});

test('credential put rejects non-DTO payloads before encryption and preserves file bytes', () => {
  const filePath = temporaryFile();
  let protectCalls = 0;
  const baseProtector = protector();
  const countingProtector: CredentialProtector = {
    protect(value: unknown): string {
      protectCalls += 1;
      return baseProtector.protect(value);
    },
    unprotect: baseProtector.unprotect,
  };
  const store = createCredentialStore({ filePath, protector: countingProtector });
  store.put(IDENTITY, { accessToken: 'fake-existing-value' });
  const before = fs.readFileSync(filePath);
  const beforeProtectCalls = protectCalls;
  let getterCalled = false;
  const accessorPayload = Object.defineProperty({}, 'accessToken', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'fake-accessor-value';
    },
  });
  const cyclicPayload: Record<string, unknown> = {};
  cyclicPayload.self = cyclicPayload;

  for (const invalid of [accessorPayload, cyclicPayload, { value: 1n }]) {
    assert.throws(
      () => store.put({ ...IDENTITY, accountId: 'invalid' }, invalid),
      /credential payload.*invalid/i,
    );
    assert.deepEqual(fs.readFileSync(filePath), before);
  }
  assert.equal(getterCalled, false);
  assert.equal(protectCalls, beforeProtectCalls);
});

test('credential put validates the exact summary DTO before changing file bytes', () => {
  const filePath = temporaryFile();
  const store = createCredentialStore({ filePath, protector: protector() });
  store.put(IDENTITY, { accessToken: 'fake-existing-value' });
  const before = fs.readFileSync(filePath);

  assert.throws(
    () => store.put(IDENTITY, { scopes: Array.from({ length: 257 }, (_, index) => `scope:${index}`) }),
    /credential summary.*invalid/i,
  );
  assert.deepEqual(fs.readFileSync(filePath), before);
});
