import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  renameCatalogArtifactWithOwner,
} from '../src/artifacts/artifact-catalog-security.js';
import {
  artifactOwnerClaimPath,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { tempRoot } from './helpers/host-http.js';

type SymlinkSync = (target: string, linkPath: string, type?: string) => void;

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function ownedSource(root: string): {
  source: string;
  target: string;
  authorization: ReturnType<typeof authorizeArtifactOwner>;
} {
  const artifactRoot = path.join(root, '.AgentCowork', 'artifacts');
  const source = path.join(artifactRoot, 'source.md');
  const target = path.join(artifactRoot, 'target.md');
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: source, owner: ALICE });
  fs.writeFileSync(source, 'SOURCE', 'utf8');
  const authorization = authorizeArtifactOwner({
    trustedRoot: root,
    artifactPath: source,
    context: ALICE,
  });
  return { source, target, authorization };
}

function rename(root: string, seeded: ReturnType<typeof ownedSource>): void {
  renameCatalogArtifactWithOwner({
    trustedRoot: root,
    source: seeded.source,
    target: seeded.target,
    context: ALICE,
    authorization: seeded.authorization,
  });
}

function aggregateIncludes(error: unknown, patterns: RegExp[]): boolean {
  if (!(error instanceof AggregateError)) return false;
  const messages = error.errors.map((item) => String(item));
  return patterns.every((pattern) => messages.some((message) => pattern.test(message)));
}

test('catalog rename rejects a junctioned claim directory without external writes', {
  skip: process.platform !== 'win32',
}, () => {
  const root = tempRoot('kcw-art-catalog-owner-junction-');
  const seeded = ownedSource(root);
  const ownerDirectory = path.dirname(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: seeded.source,
  }));
  const parked = path.join(path.dirname(ownerDirectory), '.owners-parked');
  const outside = path.join(root, 'outside-owners');
  fs.mkdirSync(outside, { recursive: true });
  fs.renameSync(ownerDirectory, parked);
  symlinkSync(outside, ownerDirectory, 'junction');

  assert.throws(
    () => rename(root, seeded),
    /managed directory|symbolic link|junction|reparse point/i,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(seeded.source, 'utf8'), 'SOURCE');
  assert.equal(fs.existsSync(seeded.target), false);
});

test('catalog rename rejects replacement of an established ordinary claim directory', () => {
  const root = tempRoot('kcw-art-catalog-owner-directory-swap-');
  const seeded = ownedSource(root);
  const ownerDirectory = path.dirname(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: seeded.source,
  }));
  const parked = path.join(path.dirname(ownerDirectory), '.owners-parked');
  const originalMkdir = fs.mkdirSync;
  let swapped = false;

  fs.mkdirSync = ((candidate: string, options?: { recursive?: boolean }) => {
    const result = originalMkdir(candidate, options);
    if (!swapped && path.resolve(String(candidate)) === path.resolve(ownerDirectory)) {
      swapped = true;
      fs.renameSync(ownerDirectory, parked);
      originalMkdir(ownerDirectory);
    }
    return result;
  }) as typeof fs.mkdirSync;
  try {
    assert.throws(
      () => rename(root, seeded),
      /managed path parent changed|managed directory changed/i,
    );
  } finally {
    fs.mkdirSync = originalMkdir;
  }

  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(ownerDirectory), []);
  assert.equal(fs.readFileSync(seeded.source, 'utf8'), 'SOURCE');
  assert.equal(fs.existsSync(seeded.target), false);
});

test('catalog rename never unlinks a source replacement created after publication', () => {
  const root = tempRoot('kcw-art-catalog-source-identity-');
  const seeded = ownedSource(root);
  const originalLink = fs.linkSync;
  let injected = false;

  fs.linkSync = ((source: string, target: string) => {
    const result = originalLink(source, target);
    if (!injected && String(source) === seeded.source && String(target) === seeded.target) {
      injected = true;
      fs.unlinkSync(seeded.source);
      fs.writeFileSync(seeded.source, 'ATTACKER', 'utf8');
    }
    return result;
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => rename(root, seeded),
      /managed path changed|rename failed/i,
    );
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(injected, true);
  assert.equal(fs.readFileSync(seeded.source, 'utf8'), 'ATTACKER');
  assert.equal(fs.readFileSync(seeded.target, 'utf8'), 'SOURCE');
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: seeded.target,
  })), false);
});

test('catalog rename rollback preserves a different target winner and removes its own claim', () => {
  const root = tempRoot('kcw-art-catalog-target-identity-');
  const seeded = ownedSource(root);
  const originalUnlink = fs.unlinkSync;
  let injected = false;

  fs.unlinkSync = ((candidate: string) => {
    if (!injected && String(candidate) === seeded.source) {
      injected = true;
      originalUnlink(seeded.source);
      originalUnlink(seeded.target);
      fs.writeFileSync(seeded.target, 'WINNER', 'utf8');
      throw new Error('injected source unlink failure');
    }
    return originalUnlink(candidate);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(
      () => rename(root, seeded),
      (error: unknown) => aggregateIncludes(error, [
        /injected source unlink failure/,
        /managed path changed/,
      ]),
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(seeded.source), false);
  assert.equal(fs.readFileSync(seeded.target, 'utf8'), 'WINNER');
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: seeded.target,
  })), false);
});
