import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createFolderGrantRegistry } from '../src/runtime/folder-grants.js';
import {
  createAesGcmProtector,
  type CredentialProtector,
} from '../src/security/credential-store.js';
import { createFolderGrantStore } from '../src/workspace/folder-grant-store.js';
import { tempRoot } from './helpers/host-http.js';

const OWNER_A = { tenantId: 'tenant-folder-a', userId: 'user-folder-a' };
const OWNER_B = { tenantId: 'tenant-folder-b', userId: 'user-folder-b' };

function sequentialClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 12, 0, 0, tick++));
}

test('folder grant store is owner-scoped, idempotent, encrypted, and preserves tombstones', () => {
  const trustedRoot = tempRoot('kcw-folder-grant-store-');
  const connectedRoot = path.join(trustedRoot, 'connected');
  const filePath = path.join(trustedRoot, 'state', 'folder-grants.json');
  fs.mkdirSync(connectedRoot);
  const ids = ['one', 'two', 'three'];
  const protector = createAesGcmProtector({ keyMaterial: 'test-folder-grant-registry-kek' });
  const store = createFolderGrantStore({
    filePath,
    protector,
    idFactory: () => ids.shift() || 'fallback',
    now: sequentialClock(),
  });

  const first = store.create({
    owner: OWNER_A,
    path: connectedRoot,
    displayName: 'Connected A',
    source: 'picker',
  });
  const duplicate = store.create({
    owner: OWNER_A,
    path: connectedRoot,
    displayName: 'A duplicate request',
    source: 'picker',
  });
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(store.list(OWNER_A).map((grant) => grant.id), [first.id]);

  assert.deepEqual(store.list(OWNER_B), []);
  assert.equal(store.get(OWNER_B, first.id), null);
  assert.equal(store.revoke(OWNER_B, first.id), null);

  const revoked = store.revoke(OWNER_A, first.id);
  assert.ok(revoked?.revokedAt);
  const revokedAgain = store.revoke(OWNER_A, first.id);
  assert.equal(revokedAgain?.id, first.id);
  assert.equal(revokedAgain?.revokedAt, revoked.revokedAt);
  assert.deepEqual(store.list(OWNER_A), []);
  assert.deepEqual(store.list(OWNER_A, { includeRevoked: true }).map((grant) => grant.id), [first.id]);

  const recreated = store.create({
    owner: OWNER_A,
    path: connectedRoot,
    displayName: 'Connected A restored',
    source: 'manual',
  });
  assert.notEqual(recreated.id, first.id);
  assert.equal(recreated.supersedesGrantId, first.id);
  assert.equal(store.list(OWNER_A).length, 1);

  const diskText = fs.readFileSync(filePath, 'utf8');
  assert.equal(diskText.includes(connectedRoot), false);
  assert.equal(diskText.includes('Connected A restored'), false);

  let unprotectCalls = 0;
  const countingProtector: CredentialProtector = {
    protect: (value) => protector.protect(value),
    unprotect(value) {
      unprotectCalls += 1;
      return protector.unprotect(value);
    },
  };
  const reloadedStore = createFolderGrantStore({ filePath, protector: countingProtector });
  const registry = createFolderGrantRegistry({ trustedRootDefault: trustedRoot, store: reloadedStore });
  assert.equal(registry.safeTrustedRoot(connectedRoot, OWNER_A, recreated.id), connectedRoot);
  assert.equal(registry.safeTrustedRoot(connectedRoot, OWNER_A, recreated.id), connectedRoot);
  assert.equal(unprotectCalls, 1, 'unchanged ciphertext should be decrypted and validated once');

  fs.writeFileSync(filePath, '{"schemaVersion":1,"sealed":"corrupt"}\n', 'utf8');
  const corruptBytes = fs.readFileSync(filePath);
  assert.throws(() => reloadedStore.list(OWNER_A), /corrupt or invalid/);
  assert.throws(() => reloadedStore.create({
    owner: OWNER_A,
    path: connectedRoot,
    displayName: 'Must not overwrite corruption',
    source: 'manual',
  }), /corrupt or invalid/);
  assert.deepEqual(fs.readFileSync(filePath), corruptBytes);
});

test('folder grant mutation guard rejects reentrant writes without creating partial state', () => {
  const trustedRoot = tempRoot('kcw-folder-grant-reentrant-');
  const connectedRoot = path.join(trustedRoot, 'connected');
  const filePath = path.join(trustedRoot, 'state', 'folder-grants.json');
  fs.mkdirSync(connectedRoot);
  const baseProtector = createAesGcmProtector({ keyMaterial: 'test-folder-grant-reentrant-kek' });
  let reenter: (() => void) | null = null;
  const protector: CredentialProtector = {
    protect(value) {
      reenter?.();
      return baseProtector.protect(value);
    },
    unprotect: (value) => baseProtector.unprotect(value),
  };
  const store = createFolderGrantStore({ filePath, protector, idFactory: () => 'outer' });
  reenter = () => {
    store.create({
      owner: OWNER_A,
      path: connectedRoot,
      displayName: 'Reentrant',
      source: 'manual',
    });
  };

  assert.throws(() => store.create({
    owner: OWNER_A,
    path: connectedRoot,
    displayName: 'Outer',
    source: 'manual',
  }), /mutation is already in progress/);
  assert.equal(fs.existsSync(filePath), false);
});

test('folder grant store refuses to write a snapshot beyond the decoder capacity', () => {
  const trustedRoot = tempRoot('kcw-folder-grant-capacity-');
  const filePath = path.join(trustedRoot, 'state', 'folder-grants.json');
  const protector = createAesGcmProtector({ keyMaterial: 'test-folder-grant-capacity-kek' });
  const timestamp = '2026-07-12T00:00:00.000Z';
  const grants = Array.from({ length: 10_000 }, (_, index) => ({
    id: `grant_seed-${index}`,
    tenantId: OWNER_A.tenantId,
    userId: OWNER_A.userId,
    path: path.join(trustedRoot, 'seed', String(index)),
    displayName: `Seed ${index}`,
    source: 'manual',
    createdAt: timestamp,
    updatedAt: timestamp,
    revokedAt: null,
    supersedesGrantId: null,
  }));
  const sealed = protector.protect(JSON.stringify({ schemaVersion: 1, grants }));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, sealed }), 'utf8');
  const before = fs.readFileSync(filePath);
  const store = createFolderGrantStore({ filePath, protector, idFactory: () => 'overflow' });

  assert.throws(() => store.create({
    owner: OWNER_A,
    path: path.join(trustedRoot, 'overflow'),
    displayName: 'Overflow',
    source: 'manual',
  }), /capacity/i);
  assert.deepEqual(fs.readFileSync(filePath), before, 'capacity failure must not alter the valid registry');
});
