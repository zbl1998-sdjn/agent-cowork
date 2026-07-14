import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  artifactOwnerClaimPath,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
  removeAuthorizedArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { rollbackFileOperations } from '../src/workspace/file-operations.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

const TENANT = 'tenant_shared';
const ALICE_OWNER = Object.freeze({ tenantId: TENANT, userId: 'alice' });
const BOB_OWNER = Object.freeze({ tenantId: TENANT, userId: 'bob' });
const ALICE = Object.freeze({ authorization: 'Bearer alice-token' });

type Preparation = Readonly<{ commit(): void; abort(): void }>;
type RollbackGuards = {
  prepareDeleteCreated?(artifactPath: string): Preparation | null;
  prepareRestoreBackup?(artifactPath: string, backupPath: string): Preparation | null;
  prepareRenameBack?(source: string, target: string): Preparation | null;
};

async function artifactRollbackGuards(trustedRoot: string, owner = ALICE_OWNER): Promise<RollbackGuards> {
  const module = await import('../src/artifacts/artifact-owner-write.js') as {
    createArtifactRollbackGuards?: (root: string, context: unknown) => RollbackGuards;
  };
  const createGuards = module.createArtifactRollbackGuards;
  if (typeof createGuards !== 'function') {
    throw new Error('createArtifactRollbackGuards export is missing');
  }
  return createGuards(trustedRoot, owner);
}

function ownedArtifact(root: string, name: string, owner: unknown, content = name): string {
  const artifactPath = path.join(root, '.AgentCowork', 'artifacts', name);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath, owner });
  fs.writeFileSync(artifactPath, content, 'utf8');
  return artifactPath;
}

function authStore() {
  return {
    resolveToken(token: string) {
      if (token === 'alice-token') return ALICE_OWNER;
      if (token === 'bob-token') return BOB_OWNER;
      return null;
    },
  };
}

async function applyNewArtifact(base: string, root: string, artifactPath: string, content: string) {
  const operations = [{ type: 'write', path: artifactPath, content }];
  const preview = await jsonRequest(base, '/api/file-ops/preview', {
    method: 'POST',
    headers: ALICE,
    body: { trustedRoot: root, operations },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const applied = await jsonRequest(base, '/api/file-ops/apply', {
    method: 'POST',
    headers: { ...ALICE, 'idempotency-key': `apply-${path.basename(artifactPath)}` },
    body: {
      trustedRoot: root,
      operations,
      fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
    },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return applied.body;
}

test('HTTP rollback cannot delete a sibling file that reoccupied an old artifact path', async () => {
  const root = tempRoot('kcw-art-rollback-route-');
  const originalPath = path.join(root, '.AgentCowork', 'artifacts', 'shared.md');
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    authStore: authStore(),
  });
  const base = await bind(server);
  try {
    const applied = await applyNewArtifact(base, root, originalPath, 'same bytes');
    const renamed = await jsonRequest(base, '/api/artifacts/rename', {
      method: 'POST',
      headers: { ...ALICE, 'idempotency-key': 'rename-before-stale-rollback' },
      body: { trustedRoot: root, path: originalPath, newName: 'alice-archived.md' },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: originalPath, owner: BOB_OWNER });
    fs.writeFileSync(originalPath, 'same bytes', 'utf8');

    const denied = await jsonRequest(base, '/api/file-ops/rollback', {
      method: 'POST',
      headers: { ...ALICE, 'idempotency-key': 'stale-delete-rollback' },
      body: {
        trustedRoot: root,
        applied: applied.applied,
        rollbackApprovalId: stringField(applied, 'rollbackApprovalId'),
      },
    });
    assert.equal(denied.status, 404, JSON.stringify(denied.body));
    assert.equal(fs.readFileSync(originalPath, 'utf8'), 'same bytes');
    authorizeArtifactOwner({ trustedRoot: root, artifactPath: originalPath, context: BOB_OWNER });
  } finally {
    await close(server);
  }
});

test('delete-created rollback removes its claim and restores it if unlink fails', async () => {
  const root = tempRoot('kcw-art-rollback-delete-');
  const guards = await artifactRollbackGuards(root);
  const target = ownedArtifact(root, 'delete-me.md', ALICE_OWNER, 'owned');
  const originalUnlink = fs.unlinkSync;
  let observedClaimRemoved = false;
  fs.unlinkSync = ((filePath: string) => {
    if (samePathReal(String(filePath), target)) {
      observedClaimRemoved = !fs.existsSync(artifactOwnerClaimPath({ trustedRoot: root, artifactPath: target }));
      throw new Error('injected unlink failure');
    }
    return originalUnlink(filePath);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(
      () => rollbackFileOperations([{ type: 'delete-created-file', path: target }], { trustedRoot: root, ...guards }),
      /injected unlink failure/,
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(observedClaimRemoved, true);
  assert.equal(fs.existsSync(target), true);
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: target, context: ALICE_OWNER });

  rollbackFileOperations([{ type: 'delete-created-file', path: target }], { trustedRoot: root, ...guards });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({ trustedRoot: root, artifactPath: target })), false);
  assert.equal(ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: target, owner: ALICE_OWNER }).created, true);
});

test('restore-backup denies sibling targets and preserves a concurrent sibling claim on copy failure', async () => {
  const root = tempRoot('kcw-art-rollback-restore-');
  const guards = await artifactRollbackGuards(root);
  const backup = path.join(root, '.AgentCowork', 'rollback', 'backup.bak');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, 'alice backup', 'utf8');

  const occupied = ownedArtifact(root, 'bob-occupied.md', BOB_OWNER, 'BOB_ONLY');
  assert.throws(
    () => rollbackFileOperations([{ type: 'restore-backup', path: occupied, backupPath: backup }], { trustedRoot: root, ...guards }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'BOB_ONLY');

  const target = path.join(root, '.AgentCowork', 'artifacts', 'copy-failure.md');
  const originalCopy = fs.copyFileSync;
  let observedReservation = false;
  fs.copyFileSync = ((source: string, destination: string) => {
    if (samePathReal(String(destination), target)) {
      const authorization = authorizeArtifactOwner({ trustedRoot: root, artifactPath: target, context: ALICE_OWNER });
      observedReservation = true;
      removeAuthorizedArtifactOwnerClaim({ trustedRoot: root, artifactPath: target, authorization });
      ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: target, owner: BOB_OWNER });
      throw new Error('injected copy failure');
    }
    return originalCopy(source, destination);
  }) as typeof fs.copyFileSync;
  try {
    assert.throws(
      () => rollbackFileOperations([{ type: 'restore-backup', path: target, backupPath: backup }], { trustedRoot: root, ...guards }),
      /injected copy failure/,
    );
  } finally {
    fs.copyFileSync = originalCopy;
  }
  assert.equal(observedReservation, true);
  assert.equal(fs.existsSync(target), false);
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: target, context: BOB_OWNER });
});

test('rename-back reserves/migrates claims, rolls them back on failure, and preserves stale targets', async () => {
  const root = tempRoot('kcw-art-rollback-rename-');
  const guards = await artifactRollbackGuards(root);
  const source = ownedArtifact(root, 'rename-source.md', ALICE_OWNER, 'owned');
  const target = path.join(path.dirname(source), 'rename-target.md');
  const originalRename = fs.renameSync;
  let observedSourceClaimPreserved = false;
  fs.renameSync = ((from: string, to: string) => {
    if (samePathReal(String(from), source) && samePathReal(String(to), target)) {
      authorizeArtifactOwner({ trustedRoot: root, artifactPath: target, context: ALICE_OWNER });
      observedSourceClaimPreserved = fs.existsSync(artifactOwnerClaimPath({
        trustedRoot: root,
        artifactPath: source,
      }));
      throw new Error('injected rename failure');
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => rollbackFileOperations([{ type: 'rename-back', from: source, to: target }], { trustedRoot: root, ...guards }),
      /injected rename failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(observedSourceClaimPreserved, true);
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: source, context: ALICE_OWNER });
  assert.equal(fs.existsSync(artifactOwnerClaimPath({ trustedRoot: root, artifactPath: target })), false);

  const staleSource = ownedArtifact(root, 'stale-source.md', ALICE_OWNER, 'owned');
  const staleTarget = path.join(path.dirname(staleSource), 'stale-target.md');
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: staleTarget, owner: BOB_OWNER });
  assert.throws(
    () => rollbackFileOperations([{ type: 'rename-back', from: staleSource, to: staleTarget }], { trustedRoot: root, ...guards }),
  );
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: staleSource, context: ALICE_OWNER });
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: staleTarget, context: BOB_OWNER });

  const successSource = ownedArtifact(root, 'success-source.md', ALICE_OWNER, 'owned');
  const successTarget = path.join(path.dirname(successSource), 'success-target.md');
  rollbackFileOperations([{ type: 'rename-back', from: successSource, to: successTarget }], { trustedRoot: root, ...guards });
  assert.equal(fs.existsSync(successSource), false);
  assert.equal(fs.existsSync(successTarget), true);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({ trustedRoot: root, artifactPath: successSource })), false);
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: successTarget, context: ALICE_OWNER });
});
