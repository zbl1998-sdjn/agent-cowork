import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createArtifactRollbackGuards } from '../src/artifacts/artifact-owner-write.js';
import {
  artifactOwnerClaimPath,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { rollbackFileOperations } from '../src/workspace/file-operations.js';
import { tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

type SymlinkSync = (target: string, linkPath: string, type?: string) => void;

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function ownedSource(root: string, name: string): string {
  const source = path.join(root, '.AgentCowork', 'artifacts', name);
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: source, owner: ALICE });
  fs.writeFileSync(source, 'SOURCE', 'utf8');
  return source;
}

function rollbackRename(root: string, source: string, target: string): void {
  rollbackFileOperations([{ type: 'rename-back', from: source, to: target }], {
    trustedRoot: root,
    ...createArtifactRollbackGuards(root, ALICE),
  });
}

test('owner rollback rename rejects claim-directory junction swaps before external file creation', {
  skip: process.platform !== 'win32',
}, () => {
  const root = tempRoot('kcw-art-owner-rename-junction-');
  const source = ownedSource(root, 'source.md');
  const target = path.join(path.dirname(source), 'target.md');
  const ownerDirectory = path.dirname(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: source,
  }));
  const parked = path.join(path.dirname(ownerDirectory), '.owners-parked');
  const outside = path.join(root, 'outside-owners');
  fs.mkdirSync(outside, { recursive: true });
  const originalMkdir = fs.mkdirSync;
  const originalOpen = fs.openSync;
  const externalWrites: string[] = [];
  let swapped = false;

  fs.mkdirSync = ((candidate: string, options?: { recursive?: boolean }) => {
    const result = originalMkdir(candidate, options);
    if (!swapped && samePathReal(String(candidate), ownerDirectory)) {
      swapped = true;
      fs.renameSync(ownerDirectory, parked);
      symlinkSync(outside, ownerDirectory, 'junction');
    }
    return result;
  }) as typeof fs.mkdirSync;
  fs.openSync = ((candidate: string, flags: string | number, mode?: number) => {
    const relative = path.relative(outside, path.resolve(String(candidate)));
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      externalWrites.push(String(candidate));
    }
    return mode === undefined
      ? originalOpen(candidate, flags)
      : originalOpen(candidate, flags, mode);
  }) as typeof fs.openSync;
  try {
    assert.throws(() => rollbackRename(root, source, target));
  } finally {
    fs.mkdirSync = originalMkdir;
    fs.openSync = originalOpen;
  }

  assert.equal(swapped, true);
  assert.deepEqual(externalWrites, []);
  assert.equal(fs.readFileSync(source, 'utf8'), 'SOURCE');
  assert.equal(fs.existsSync(target), false);
});

test('owner rollback rename rejects a different target identity after the filesystem move', () => {
  const root = tempRoot('kcw-art-owner-rename-winner-');
  const source = ownedSource(root, 'source.md');
  const target = path.join(path.dirname(source), 'target.md');
  const originalRename = fs.renameSync;
  let injected = false;

  fs.renameSync = ((from: string, to: string) => {
    const result = originalRename(from, to);
    if (!injected && samePathReal(String(from), source) && samePathReal(String(to), target)) {
      injected = true;
      fs.unlinkSync(target);
      fs.writeFileSync(target, 'WINNER', 'utf8');
    }
    return result;
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => rollbackRename(root, source, target),
      /managed path changed|ownership recovery failed/i,
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'WINNER');
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: target, context: ALICE });
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: source,
  })), true);
});
