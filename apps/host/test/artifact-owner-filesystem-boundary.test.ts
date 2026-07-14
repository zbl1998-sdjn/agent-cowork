import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  artifactOwnerClaimPath,
  artifactOwnerMetadata,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
  removeAuthorizedArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const BOB = Object.freeze({ tenantId: 'tenant_shared', userId: 'bob' });

function ownedArtifact(root: string): { artifactPath: string; claimPath: string } {
  const artifactPath = path.join(root, '.AgentCowork', 'artifacts', 'private.md');
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath, owner: ALICE });
  fs.writeFileSync(artifactPath, 'ALICE_ONLY', 'utf8');
  return {
    artifactPath,
    claimPath: artifactOwnerClaimPath({ trustedRoot: root, artifactPath }),
  };
}

function isDeniedOrChanged(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 404
    || /managed path|managed directory|changed during operation/i.test(String(error));
}

test('owner authorization rejects an ordinary .owners directory replacement', () => {
  const root = tempRoot('kcw-art-owner-directory-replacement-');
  const { artifactPath, claimPath } = ownedArtifact(root);
  const ownerDirectory = path.dirname(claimPath);
  const parkedDirectory = path.join(path.dirname(ownerDirectory), '.owners-parked');
  const claimText = fs.readFileSync(claimPath, 'utf8');
  const originalLstat = fs.lstatSync;
  let replaced = false;

  fs.lstatSync = ((candidate: fs.PathLike) => {
    const result = originalLstat(String(candidate));
    if (!replaced && samePathReal(String(candidate), claimPath)) {
      replaced = true;
      fs.renameSync(ownerDirectory, parkedDirectory);
      fs.mkdirSync(ownerDirectory);
      fs.writeFileSync(claimPath, claimText, 'utf8');
    }
    return result;
  }) as typeof fs.lstatSync;
  try {
    assert.throws(
      () => authorizeArtifactOwner({ trustedRoot: root, artifactPath, context: ALICE }),
      isDeniedOrChanged,
    );
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(claimPath, 'utf8'), claimText);
});

test('owner authorization rejects a claim identity replaced during descriptor read', () => {
  const root = tempRoot('kcw-art-owner-claim-read-replacement-');
  const { artifactPath, claimPath } = ownedArtifact(root);
  const parkedClaim = path.join(root, 'parked-owner-claim.json');
  const claimText = fs.readFileSync(claimPath, 'utf8');
  const originalRead = fs.readFileSync;
  const readText = originalRead as unknown as (candidate: string | number, encoding: 'utf8') => string;
  let attempted = false;

  fs.readFileSync = ((candidate: string | number, encoding: 'utf8') => {
    const result = readText(candidate, encoding);
    if (!attempted && (typeof candidate === 'number'
      || samePathReal(String(candidate), claimPath))) {
      attempted = true;
      fs.renameSync(claimPath, parkedClaim);
      fs.writeFileSync(claimPath, claimText, 'utf8');
    }
    return result;
  }) as typeof fs.readFileSync;
  try {
    assert.throws(
      () => authorizeArtifactOwner({ trustedRoot: root, artifactPath, context: ALICE }),
      isDeniedOrChanged,
    );
  } finally {
    fs.readFileSync = originalRead;
  }

  assert.equal(attempted, true);
  assert.equal(fs.existsSync(claimPath), true);
});

test('authorized claim deletion preserves a replacement claim', () => {
  const root = tempRoot('kcw-art-owner-claim-delete-replacement-');
  const { artifactPath, claimPath } = ownedArtifact(root);
  const authorization = authorizeArtifactOwner({ trustedRoot: root, artifactPath, context: ALICE });
  const parkedClaim = path.join(root, 'parked-alice-claim.json');
  const bobClaim = `${JSON.stringify(artifactOwnerMetadata({
    trustedRoot: root,
    artifactPath,
    owner: BOB,
  }))}\n`;
  let guardedCalls = 0;
  let replaced = false;

  assert.throws(
    () => removeAuthorizedArtifactOwnerClaim({
      trustedRoot: root,
      artifactPath,
      authorization,
      beforeFilesystemMutation(candidatePath) {
        if (path.resolve(candidatePath) !== path.resolve(claimPath)) return;
        guardedCalls += 1;
        if (guardedCalls !== 2) return;
        replaced = true;
        fs.renameSync(claimPath, parkedClaim);
        fs.writeFileSync(claimPath, bobClaim, 'utf8');
      },
    }),
    isDeniedOrChanged,
  );

  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(claimPath, 'utf8'), bobClaim);
  authorizeArtifactOwner({ trustedRoot: root, artifactPath, context: BOB });
});
