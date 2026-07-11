import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renameArtifact } from '../src/artifacts/artifact-catalog.js';
import {
  artifactOwnerClaimPath,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const BOB = Object.freeze({ tenantId: 'tenant_shared', userId: 'bob' });

test('catalog rollback removes its own claim but preserves a concurrent sibling claim', () => {
  const root = tempRoot('kcw-art-catalog-claim-race-');
  const artifactRoot = path.join(root, '.AgentCowork', 'artifacts');
  const source = path.join(artifactRoot, 'source.md');
  const target = path.join(artifactRoot, 'target.md');
  const targetClaim = artifactOwnerClaimPath({ trustedRoot: root, artifactPath: target });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: source, owner: ALICE });
  fs.writeFileSync(source, 'SOURCE', 'utf8');
  const originalLink = fs.linkSync;
  let injected = false;

  fs.linkSync = ((existingPath: string, newPath: string) => {
    if (!injected && newPath === target) {
      injected = true;
      fs.unlinkSync(targetClaim);
      ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: target, owner: BOB });
      fs.writeFileSync(target, 'BOB_WINNER', 'utf8');
    }
    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => renameArtifact({
        trustedRoot: root,
        artifactPath: source,
        newName: path.basename(target),
        context: ALICE,
      }),
      (error: unknown) => (error as { statusCode?: unknown }).statusCode === 409,
    );
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(injected, true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'SOURCE');
  assert.equal(fs.readFileSync(target, 'utf8'), 'BOB_WINNER');
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: source, context: ALICE });
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: target, context: BOB });
  assert.equal(fs.existsSync(targetClaim), true);
});
