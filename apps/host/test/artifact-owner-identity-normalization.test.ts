import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createArtifactAccessGuards } from '../src/artifacts/artifact-access-guards.js';
import {
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
  LOCAL_ARTIFACT_OWNER,
  normalizeArtifactOwner,
} from '../src/artifacts/artifact-owner.js';
import { tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const BOB = Object.freeze({ tenantId: 'tenant_shared', userId: 'bob' });

function aliceArtifact(): { root: string; artifactPath: string } {
  const root = tempRoot('kcw-art-owner-identity-');
  const artifactPath = path.join(root, '.AgentCowork', 'artifacts', 'alice.md');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath, owner: ALICE });
  fs.writeFileSync(artifactPath, 'ALICE_ONLY', 'utf8');
  return { root, artifactPath };
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 404;
}

test('artifact authorization rejects non-canonical and incomplete owner identities', () => {
  const { root, artifactPath } = aliceArtifact();
  const invalid = [
    {},
    { tenantId: 'tenant_shared', userId: 'alice ' },
    { tenantId: 'tenant_shared', userId: ['alice'] },
    { tenantId: 'tenant_shared', userId: { value: 'alice' } },
    { tenantId: 'tenant_shared' },
    { tenantId: 'tenant_shared', userId: 'a'.repeat(97) },
  ];
  for (const context of invalid) {
    assert.throws(
      () => authorizeArtifactOwner({ trustedRoot: root, artifactPath, context }),
      isNotFound,
    );
  }
  authorizeArtifactOwner({ trustedRoot: root, artifactPath, context: ALICE });
});

test('artifact owner normalization never invokes identity accessors', () => {
  let getterRuns = 0;
  const context = Object.defineProperties({}, {
    tenantId: {
      enumerable: true,
      get() {
        getterRuns += 1;
        return 'tenant_shared';
      },
    },
    userId: { enumerable: true, value: 'alice' },
  });
  assert.throws(() => normalizeArtifactOwner(context), isNotFound);
  assert.equal(getterRuns, 0);
  const hostileProxy = new Proxy({ tenantId: 'tenant_shared', userId: 'alice' }, {
    getOwnPropertyDescriptor() {
      throw new Error('descriptor trap');
    },
  });
  assert.throws(() => normalizeArtifactOwner(hostileProxy), isNotFound);
});

test('artifact access guards freeze a canonical owner snapshot', () => {
  const { root, artifactPath } = aliceArtifact();
  const mutableBob: { tenantId: string; userId: string } = { ...BOB };
  const bobGuard = createArtifactAccessGuards(root, mutableBob);
  assert.equal(bobGuard.owner === mutableBob, false);
  assert.equal(Object.isFrozen(bobGuard.owner), true);
  mutableBob.userId = 'alice';
  assert.throws(() => bobGuard.readPath(artifactPath), isNotFound);

  const mutableAlice: { tenantId: string; userId: string } = { ...ALICE };
  const aliceGuard = createArtifactAccessGuards(root, mutableAlice);
  mutableAlice.userId = 'bob';
  assert.ok(samePathReal(aliceGuard.readPath(artifactPath), artifactPath));
  assert.deepEqual(aliceGuard.owner, ALICE);
});

test('local owner fallback is explicit and invalid non-record contexts fail closed', () => {
  assert.equal(normalizeArtifactOwner(undefined, { allowLocalDefault: true }), LOCAL_ARTIFACT_OWNER);
  for (const context of [null, [], 'local', {}, { requestId: 'local' }]) {
    assert.throws(
      () => normalizeArtifactOwner(context, { allowLocalDefault: true }),
      isNotFound,
    );
  }
});
