import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  artifactOwnerClaimPath,
} from '../src/artifacts/artifact-owner.js';
import {
  buildLiveArtifact,
  readArtifactManifest,
  readLiveArtifactHtml,
} from '../src/artifacts/live-artifact.js';
import { artifactPaths } from '../src/artifacts/live-spec.js';
import { tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

type SymlinkSync = (target: string, linkPath: string, type?: string) => void;

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const VIZ = Object.freeze({ kind: 'table', data: { columns: ['value'], rows: [[1]] } });
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function build(root: string, id: string, owner?: unknown) {
  return buildLiveArtifact({ trustedRoot: root, id, owner, viz: VIZ });
}

function isFilesystemBoundaryError(error: unknown): boolean {
  const pattern = /managed directory|symbolic link|junction|reparse point/i;
  return pattern.test(String(error))
    || (error instanceof AggregateError
      && error.errors.some((item) => pattern.test(String(item))));
}

test('live build rejects artifact-root junction swaps before claim and page writes', {
  skip: process.platform !== 'win32',
}, () => {
  for (const swapPoint of ['claim', 'html'] as const) {
    const root = tempRoot(`kcw-art-live-junction-${swapPoint}-`);
    const paths = artifactPaths({ trustedRoot: root, id: `viz_junction_${swapPoint}` });
    const outside = path.join(root, `outside-${swapPoint}`);
    const parked = path.join(root, `parked-${swapPoint}`);
    fs.mkdirSync(outside, { recursive: true });
    const originalMkdir = fs.mkdirSync;
    let artifactRootMkdirCalls = 0;
    let swapped = false;

    fs.mkdirSync = ((candidate: string, options?: { recursive?: boolean }) => {
      const result = originalMkdir(candidate, options);
      const resolved = path.resolve(String(candidate));
      if (resolved === path.resolve(paths.dir)) artifactRootMkdirCalls += 1;
      const shouldSwap = !swapped && (
        (swapPoint === 'claim' && path.basename(resolved) === '.owners')
        || (swapPoint === 'html'
          && resolved === path.resolve(paths.dir)
          && artifactRootMkdirCalls === 2)
      );
      if (shouldSwap) {
        swapped = true;
        fs.renameSync(paths.dir, parked);
        symlinkSync(outside, paths.dir, 'junction');
        if (swapPoint === 'claim') originalMkdir(path.join(outside, '.owners'), { recursive: true });
      }
      return result;
    }) as typeof fs.mkdirSync;
    try {
      assert.throws(
        () => build(root, `viz_junction_${swapPoint}`, swapPoint === 'claim' ? ALICE : undefined),
        isFilesystemBoundaryError,
      );
    } finally {
      fs.mkdirSync = originalMkdir;
    }

    assert.equal(swapped, true);
    const externalFiles = swapPoint === 'claim'
      ? fs.readdirSync(path.join(outside, '.owners'))
      : fs.readdirSync(outside);
    assert.deepEqual(externalFiles, [], swapPoint);
  }
});

test('live build rejects a junctioned owner-claim directory without external writes', {
  skip: process.platform !== 'win32',
}, () => {
  const root = tempRoot('kcw-art-live-owner-junction-');
  const id = 'viz_owner_junction';
  const paths = artifactPaths({ trustedRoot: root, id });
  const outside = path.join(root, 'outside-owners');
  const ownerDirectory = path.join(paths.dir, '.owners');
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  symlinkSync(outside, ownerDirectory, 'junction');

  assert.throws(() => build(root, id, ALICE), isFilesystemBoundaryError);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('live build rejects replacement of an established ordinary claim directory', () => {
  const root = tempRoot('kcw-art-live-owner-directory-swap-');
  const id = 'viz_owner_directory_swap';
  const paths = artifactPaths({ trustedRoot: root, id });
  const ownerDirectory = path.join(paths.dir, '.owners');
  const parked = path.join(paths.dir, '.owners-parked');
  fs.mkdirSync(ownerDirectory, { recursive: true });
  const originalMkdir = fs.mkdirSync;
  let swapped = false;

  fs.mkdirSync = ((candidate: string, options?: { recursive?: boolean }) => {
    const result = originalMkdir(candidate, options);
    if (!swapped && samePathReal(String(candidate), ownerDirectory)) {
      swapped = true;
      fs.renameSync(ownerDirectory, parked);
      originalMkdir(ownerDirectory);
    }
    return result;
  }) as typeof fs.mkdirSync;
  try {
    assert.throws(
      () => build(root, id, ALICE),
      /managed path parent changed|managed directory changed/i,
    );
  } finally {
    fs.mkdirSync = originalMkdir;
  }

  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(ownerDirectory), []);
  assert.equal(fs.existsSync(paths.htmlPath), false);
  assert.equal(fs.existsSync(paths.manifestPath), false);
});

test('failed publisher never unlinks a same-owner nested winner with a different file identity', () => {
  const root = tempRoot('kcw-art-live-identity-rollback-');
  const id = 'viz_identity_rollback';
  const paths = artifactPaths({ trustedRoot: root, id });
  const originalLink = fs.linkSync;
  let nestedBuilt = false;
  let injecting = false;

  fs.linkSync = ((source: string, target: string) => {
    if (!injecting && String(target) === paths.manifestPath) {
      injecting = true;
      fs.unlinkSync(paths.htmlPath);
      build(root, id, ALICE);
      nestedBuilt = true;
      throw new Error('injected outer manifest publish failure');
    }
    return originalLink(source, target);
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => build(root, id, ALICE),
      (error: unknown) => String(error).includes('outer manifest publish failure')
        || (error instanceof AggregateError
          && error.errors.some((item) => String(item).includes('outer manifest publish failure'))),
    );
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(nestedBuilt, true);
  assert.equal(readArtifactManifest({ trustedRoot: root, id, context: ALICE }).id, id);
  assert.match(readLiveArtifactHtml({ trustedRoot: root, id, context: ALICE }), /agent-cowork-live-artifact:v1/);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: paths.htmlPath,
  })), true);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot: root,
    artifactPath: paths.manifestPath,
  })), true);
});
