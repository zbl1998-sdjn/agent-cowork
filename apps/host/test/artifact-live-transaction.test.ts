import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  artifactOwnerClaimPath,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import {
  buildLiveArtifact,
  readArtifactManifest,
  readLiveArtifactHtml,
} from '../src/artifacts/live-artifact.js';
import { artifactPaths } from '../src/artifacts/live-spec.js';
import { tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const BOB = Object.freeze({ tenantId: 'tenant_shared', userId: 'bob' });
const VIZ = Object.freeze({ kind: 'table', data: { columns: ['value'], rows: [[1]] } });

function build(root: string, id: string, owner: unknown = ALICE) {
  return buildLiveArtifact({ trustedRoot: root, id, owner, viz: VIZ });
}

test('same-owner claim-only remnants are recoverable', () => {
  const root = tempRoot('kcw-art-live-claims-retry-');
  const paths = artifactPaths({ trustedRoot: root, id: 'viz_claim_retry' });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: paths.htmlPath, owner: ALICE });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: paths.manifestPath, owner: ALICE });

  const built = build(root, 'viz_claim_retry');

  assert.equal(fs.existsSync(built.htmlPath), true);
  assert.equal(fs.existsSync(built.manifestPath), true);
  assert.equal(readArtifactManifest({ trustedRoot: root, id: built.id, context: ALICE }).id, built.id);
});

test('claim-only remnants owned by another principal fail closed', () => {
  const root = tempRoot('kcw-art-live-claims-owner-');
  const paths = artifactPaths({ trustedRoot: root, id: 'viz_claim_owner' });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: paths.htmlPath, owner: BOB });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: paths.manifestPath, owner: BOB });

  assert.throws(
    () => build(root, 'viz_claim_owner'),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );
  assert.equal(fs.existsSync(paths.htmlPath), false);
  assert.equal(fs.existsSync(paths.manifestPath), false);
});

test('same-owner concurrent build publishes one complete pair without deleting shared claims', () => {
  const root = tempRoot('kcw-art-live-concurrent-');
  const id = 'viz_concurrent';
  const paths = artifactPaths({ trustedRoot: root, id });
  const originalLink = fs.linkSync;
  let interleaving = false;
  let nestedBuilt = false;

  fs.linkSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (!interleaving && String(target) === paths.htmlPath) {
      interleaving = true;
      build(root, id);
      nestedBuilt = true;
    }
    return originalLink(source, target);
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => build(root, id),
      (error: unknown) => (error as { statusCode?: unknown }).statusCode === 409,
    );
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(nestedBuilt, true);
  assert.equal(readArtifactManifest({ trustedRoot: root, id, context: ALICE }).id, id);
  assert.match(readLiveArtifactHtml({ trustedRoot: root, id, context: ALICE }), /agent-cowork-live-artifact:v1/);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({ trustedRoot: root, artifactPath: paths.htmlPath })), true);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({ trustedRoot: root, artifactPath: paths.manifestPath })), true);
});

test('publish and rollback failures are both reported and preserve ownership claims', () => {
  const root = tempRoot('kcw-art-live-rollback-');
  const id = 'viz_rollback_failure';
  const paths = artifactPaths({ trustedRoot: root, id });
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;

  fs.linkSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === paths.manifestPath) throw new Error('injected manifest publish failure');
    return originalLink(source, target);
  }) as typeof fs.linkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (String(target) === paths.htmlPath) throw new Error('injected html rollback failure');
    return originalUnlink(target);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(
      () => build(root, id),
      (error: unknown) => error instanceof AggregateError
        && error.errors.some((item) => /manifest publish failure/.test(String(item)))
        && error.errors.some((item) => /html rollback failure/.test(String(item))),
    );
  } finally {
    fs.unlinkSync = originalUnlink;
    fs.linkSync = originalLink;
  }

  assert.equal(fs.existsSync(paths.htmlPath), true);
  assert.equal(fs.existsSync(paths.manifestPath), false);
  assert.doesNotThrow(() => authorizeArtifactOwner({
    trustedRoot: root,
    artifactPath: paths.htmlPath,
    context: ALICE,
  }));
  assert.doesNotThrow(() => authorizeArtifactOwner({
    trustedRoot: root,
    artifactPath: paths.manifestPath,
    context: ALICE,
  }));
  assert.throws(
    () => readLiveArtifactHtml({ trustedRoot: root, id, context: ALICE }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );
});
