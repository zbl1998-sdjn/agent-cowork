import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { authorizeCatalogArtifactFile } from '../src/artifacts/artifact-catalog-security.js';
import {
  listArtifacts,
  renameArtifact,
  renderArtifactHtml,
} from '../src/artifacts/artifact-catalog.js';
import {
  artifactOwnerMetadata,
  artifactOwnerClaimPath,
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const BOB = Object.freeze({ tenantId: 'tenant_shared', userId: 'bob' });

function ownedFile(root: string, name: string, owner: unknown, content: string): string {
  const artifactPath = path.join(root, '.AgentCowork', 'artifacts', name);
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath, owner });
  fs.writeFileSync(artifactPath, content, 'utf8');
  return artifactPath;
}

function ownedStandaloneManifest(root: string, id: string): string {
  const manifestPath = path.join(root, '.AgentCowork', 'artifacts', `${id}.json`);
  ensureArtifactOwnerClaim({ trustedRoot: root, artifactPath: manifestPath, owner: ALICE });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    artifactType: 'live-artifact',
    schemaVersion: 1,
    id,
    title: id,
    dataUrl: `/api/artifacts/data/${id}`,
    createdAt: '2026-07-11T00:00:00.000Z',
    viz: { kind: 'table', data: { columns: ['value'], rows: [['original']] } },
    owner: artifactOwnerMetadata({ trustedRoot: root, artifactPath: manifestPath, owner: ALICE }),
  }, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function aggregateIncludes(error: unknown, patterns: RegExp[]): boolean {
  if (!(error instanceof AggregateError)) return false;
  const messages = error.errors.map((item) => String(item));
  return patterns.every((pattern) => messages.some((message) => pattern.test(message)));
}

test('catalog rename never overwrites a target created after the target preflight', () => {
  const root = tempRoot('kcw-art-catalog-race-');
  const source = ownedFile(root, 'source.md', ALICE, 'SOURCE');
  const target = path.join(path.dirname(source), 'target.md');
  const sourceClaim = artifactOwnerClaimPath({ trustedRoot: root, artifactPath: source });
  const targetClaim = artifactOwnerClaimPath({ trustedRoot: root, artifactPath: target });
  const originalExists = fs.existsSync;
  let interleaved = false;
  let targetChecks = 0;

  fs.existsSync = ((candidate: fs.PathLike) => {
    if (samePathReal(String(candidate), target)) targetChecks += 1;
    if (!interleaved && samePathReal(String(candidate), target) && targetChecks === 2) {
      interleaved = true;
      fs.writeFileSync(target, 'CONCURRENT_WINNER', 'utf8');
      return false;
    }
    return originalExists(candidate);
  }) as typeof fs.existsSync;
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
    fs.existsSync = originalExists;
  }

  assert.equal(interleaved, true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'SOURCE');
  assert.equal(fs.readFileSync(target, 'utf8'), 'CONCURRENT_WINNER');
  assert.equal(fs.existsSync(sourceClaim), true);
  assert.equal(fs.existsSync(targetClaim), false);
  authorizeArtifactOwner({ trustedRoot: root, artifactPath: source, context: ALICE });
});

test('JSON rename reports an atomic rollback write failure and leaves an authorized committed target', () => {
  const root = tempRoot('kcw-art-catalog-write-rollback-');
  const source = ownedStandaloneManifest(root, 'viz_catalog_write_rollback');
  const target = path.join(path.dirname(source), 'viz_catalog_write_committed.json');
  const sourceClaim = artifactOwnerClaimPath({ trustedRoot: root, artifactPath: source });
  const originalManifest = fs.readFileSync(source, 'utf8');
  const originalUnlink = fs.unlinkSync;
  const originalWrite = fs.writeFileSync;
  let rollbackWriteReached = false;

  fs.unlinkSync = ((candidate: fs.PathLike) => {
    if (samePathReal(String(candidate), sourceClaim)) throw new Error('injected claim cleanup failure');
    return originalUnlink(candidate);
  }) as typeof fs.unlinkSync;
  fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    const [destination, data] = args;
    if (typeof destination === 'number' && data === originalManifest) {
      rollbackWriteReached = true;
      originalWrite(destination, originalManifest.slice(0, 32), 'utf8');
      throw new Error('injected rollback write failure');
    }
    return Reflect.apply(originalWrite, fs, args);
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(
      () => renameArtifact({
        trustedRoot: root,
        artifactPath: source,
        newName: path.basename(target),
        context: ALICE,
      }),
      (error: unknown) => aggregateIncludes(error, [
        /injected claim cleanup failure/,
        /injected rollback write failure/,
      ]),
    );
  } finally {
    fs.writeFileSync = originalWrite;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(rollbackWriteReached, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(target), true);
  assert.doesNotThrow(() => authorizeCatalogArtifactFile(root, target, ALICE));
});

test('JSON rename reports rename-back publication failure without corrupting target authorization', () => {
  const root = tempRoot('kcw-art-catalog-move-rollback-');
  const source = ownedStandaloneManifest(root, 'viz_catalog_move_rollback');
  const target = path.join(path.dirname(source), 'viz_catalog_move_committed.json');
  const sourceClaim = artifactOwnerClaimPath({ trustedRoot: root, artifactPath: source });
  const originalUnlink = fs.unlinkSync;
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let rollbackMoveReached = false;

  fs.unlinkSync = ((candidate: fs.PathLike) => {
    if (samePathReal(String(candidate), sourceClaim)) throw new Error('injected claim cleanup failure');
    return originalUnlink(candidate);
  }) as typeof fs.unlinkSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (samePathReal(String(from), target) && samePathReal(String(to), source)) {
      rollbackMoveReached = true;
      throw new Error('injected rename-back failure');
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (samePathReal(String(newPath), source)) {
      rollbackMoveReached = true;
      throw new Error('injected rename-back failure');
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
      (error: unknown) => aggregateIncludes(error, [
        /injected claim cleanup failure/,
        /injected rename-back failure/,
      ]),
    );
  } finally {
    fs.linkSync = originalLink;
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(rollbackMoveReached, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(target), true);
  assert.doesNotThrow(() => authorizeCatalogArtifactFile(root, target, ALICE));
});

test('claimed business JSON may contain an ordinary owner field', () => {
  const root = tempRoot('kcw-art-catalog-business-owner-');
  const artifactPath = ownedFile(root, 'business.json', ALICE, JSON.stringify({
    owner: { department: 'finance' },
    id: 'business',
    title: 'Quarterly plan',
    dataUrl: '/reports/business',
    createdAt: '2026-07-11T00:00:00.000Z',
    viz: { kind: 'table', data: { columns: ['value'], rows: [[42]] } },
  }));

  assert.doesNotThrow(() => authorizeCatalogArtifactFile(root, artifactPath, ALICE));
  assert.deepEqual(listArtifacts({ trustedRoot: root, context: ALICE }).map((item) => item.name), [
    'business.json',
  ]);
});

test('a manifest-shaped sibling-owned JSON with the same basename does not hide HTML', () => {
  const root = tempRoot('kcw-art-catalog-pair-');
  const htmlPath = ownedFile(root, 'report.html', ALICE, '<h1>ALICE_REPORT</h1>');
  ownedFile(root, 'report.json', BOB, JSON.stringify({
    owner: { department: 'bob' },
    id: 'report',
    title: 'Forged sibling manifest',
    dataUrl: '/api/artifacts/data/report',
    createdAt: '2026-07-11T00:00:00.000Z',
    viz: { kind: 'table', data: { columns: ['secret'], rows: [['BOB_REPORT']] } },
  }));

  const aliceNames = listArtifacts({ trustedRoot: root, context: ALICE }).map((item) => item.name);
  assert.deepEqual(aliceNames, ['report.html']);
  assert.match(renderArtifactHtml({ trustedRoot: root, artifactPath: htmlPath, context: ALICE }), /ALICE_REPORT/);
});
