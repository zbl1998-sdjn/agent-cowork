import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildLiveArtifact,
  buildLiveArtifactVersion,
  readArtifactManifest,
} from '../src/artifacts/live-artifact.js';
import {
  computeArtifactContentSha256,
  listArtifactVersions,
} from '../src/artifacts/artifact-version-chain.js';
import type { ArtifactManifest } from '../src/artifacts/live-artifact-reader.js';
import { listArtifacts } from '../src/artifacts/artifact-catalog.js';
import { artifactPaths } from '../src/artifacts/live-spec.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

const ALICE_IDENTITY = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const BOB_IDENTITY = Object.freeze({ tenantId: 'tenant_shared', userId: 'bob' });
const ALICE_HEADERS = Object.freeze({ authorization: 'Bearer alice-token' });
const BOB_HEADERS = Object.freeze({ authorization: 'Bearer bob-token' });
const SHA256_RE = /^[a-f0-9]{64}$/;

function table(value: number) {
  return { kind: 'table', data: { columns: ['value'], rows: [[value]] } };
}

function statusIs(expected: number) {
  return (error: unknown): boolean => (error as { statusCode?: unknown }).statusCode === expected;
}

function siblingAuthStore() {
  return {
    resolveToken(token: string) {
      if (token === 'alice-token') return ALICE_IDENTITY;
      if (token === 'bob-token') return { tenantId: 'tenant_shared', userId: 'bob' };
      return null;
    },
  };
}

test('artifact content hashes include own __proto__ keys', () => {
  const left = JSON.parse('{"id":"viz_hash","__proto__":{"approved":false}}') as ArtifactManifest;
  const right = JSON.parse('{"id":"viz_hash","__proto__":{"approved":true}}') as ArtifactManifest;

  assert.notEqual(
    computeArtifactContentSha256(left, '<p>same</p>'),
    computeArtifactContentSha256(right, '<p>same</p>'),
  );
});

test('new artifact versions form an immutable owner-scoped lineage without overwriting the parent', () => {
  const root = tempRoot('kcw-art-version-chain-');
  const parent = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_report_v1',
    title: 'Quarterly report',
    owner: ALICE_IDENTITY,
    viz: table(1),
  });
  const parentHtmlBefore = fs.readFileSync(parent.htmlPath, 'utf8');
  const parentManifestBefore = fs.readFileSync(parent.manifestPath, 'utf8');

  const child = buildLiveArtifactVersion({
    trustedRoot: root,
    parentVersionId: parent.id,
    id: 'viz_report_v2',
    title: 'Quarterly report',
    context: ALICE_IDENTITY,
    viz: table(2),
  });

  const parentManifest = readArtifactManifest({ trustedRoot: root, id: parent.id, context: ALICE_IDENTITY });
  const childManifest = readArtifactManifest({ trustedRoot: root, id: child.id, context: ALICE_IDENTITY });
  const childManifestBefore = fs.readFileSync(child.manifestPath, 'utf8');
  assert.equal(parentManifest.lineageId, parent.id);
  assert.equal(parentManifest.parentVersionId, undefined);
  assert.match(parentManifest.contentSha256 || '', SHA256_RE);
  assert.equal(childManifest.lineageId, parent.id);
  assert.equal(childManifest.parentVersionId, parent.id);
  assert.match(childManifest.contentSha256 || '', SHA256_RE);
  assert.notEqual(childManifest.contentSha256, parentManifest.contentSha256);
  assert.equal(fs.readFileSync(parent.htmlPath, 'utf8'), parentHtmlBefore);
  assert.equal(fs.readFileSync(parent.manifestPath, 'utf8'), parentManifestBefore);
  assert.equal(
    listArtifacts({ trustedRoot: root, context: ALICE_IDENTITY, limit: 20 })
      .find((item) => item.name === `${parent.id}.html`)?.liveArtifactId,
    parent.id,
  );

  const history = listArtifactVersions({ trustedRoot: root, id: child.id, context: ALICE_IDENTITY });
  assert.deepEqual(new Set(history.map((version) => version.id)), new Set([parent.id, child.id]));
  assert.equal(history.find((version) => version.id === child.id)?.parentVersionId, parent.id);
  assert.equal(history.every((version) => version.hashVerified), true);

  assert.throws(() => buildLiveArtifactVersion({
    trustedRoot: root,
    parentVersionId: parent.id,
    id: parent.id,
    context: ALICE_IDENTITY,
    viz: table(3),
  }), statusIs(409));
  assert.throws(() => buildLiveArtifactVersion({
    trustedRoot: root,
    parentVersionId: parent.id,
    id: child.id,
    context: ALICE_IDENTITY,
    viz: table(4),
  }), statusIs(409));
  assert.equal(fs.readFileSync(child.manifestPath, 'utf8'), childManifestBefore);
});

test('legacy v1 manifests remain readable history singletons but cannot become an unverifiable parent', () => {
  const root = tempRoot('kcw-art-version-legacy-');
  const legacy = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_legacy_v1',
    title: 'Legacy report',
    viz: table(1),
  });
  const stored = JSON.parse(fs.readFileSync(legacy.manifestPath, 'utf8')) as Record<string, unknown>;
  delete stored.lineageId;
  delete stored.parentVersionId;
  delete stored.contentSha256;
  fs.writeFileSync(legacy.manifestPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

  assert.equal(readArtifactManifest({ trustedRoot: root, id: legacy.id }).id, legacy.id);
  const history = listArtifactVersions({ trustedRoot: root, id: legacy.id });
  assert.equal(history.length, 1);
  assert.equal(history[0]?.lineageId, legacy.id);
  assert.equal(history[0]?.hashVerified, false);
  assert.match(history[0]?.contentSha256 || '', SHA256_RE);

  assert.throws(() => buildLiveArtifactVersion({
    trustedRoot: root,
    parentVersionId: legacy.id,
    id: 'viz_legacy_v2',
    viz: table(2),
  }), statusIs(409));
  const childPaths = artifactPaths({ trustedRoot: root, id: 'viz_legacy_v2' });
  assert.equal(fs.existsSync(childPaths.htmlPath), false);
  assert.equal(fs.existsSync(childPaths.manifestPath), false);
});

test('version creation fails closed on parent content tampering and publishes no child pair', () => {
  const root = tempRoot('kcw-art-version-tamper-');
  const parent = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_tamper_v1',
    viz: table(1),
  });
  fs.appendFileSync(parent.htmlPath, '\n<!-- tampered -->\n', 'utf8');

  assert.throws(() => buildLiveArtifactVersion({
    trustedRoot: root,
    parentVersionId: parent.id,
    id: 'viz_tamper_v2',
    viz: table(2),
  }), statusIs(409));
  const childPaths = artifactPaths({ trustedRoot: root, id: 'viz_tamper_v2' });
  assert.equal(fs.existsSync(childPaths.htmlPath), false);
  assert.equal(fs.existsSync(childPaths.manifestPath), false);
});

test('history ignores malformed unrelated manifests and reads no sibling-owner artifact bytes', () => {
  const root = tempRoot('kcw-art-version-siblings-');
  const parent = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_history_v1',
    owner: ALICE_IDENTITY,
    viz: table(1),
  });
  buildLiveArtifactVersion({
    trustedRoot: root,
    parentVersionId: parent.id,
    id: 'viz_history_v2',
    context: ALICE_IDENTITY,
    viz: table(2),
  });
  const malformed = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_unrelated_bad',
    owner: ALICE_IDENTITY,
    viz: table(3),
  });
  fs.writeFileSync(malformed.manifestPath, '{ malformed', 'utf8');
  const bob = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_bob_private',
    owner: BOB_IDENTITY,
    viz: table(4),
  });

  const originalRead = fs.readFileSync;
  let siblingPairReads = 0;
  fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(candidate) === bob.htmlPath || String(candidate) === bob.manifestPath) {
      siblingPairReads += 1;
      throw new Error('sibling owner artifact bytes were read');
    }
    return Reflect.apply(originalRead, fs, [candidate, ...args] as Parameters<typeof fs.readFileSync>);
  }) as typeof fs.readFileSync;
  try {
    assert.deepEqual(
      new Set(listArtifactVersions({ trustedRoot: root, id: parent.id, context: ALICE_IDENTITY })
        .map((version) => version.id)),
      new Set(['viz_history_v1', 'viz_history_v2']),
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(siblingPairReads, 0);
});

test('history route is read-only, owner-scoped, and mounted in the server route chain', async () => {
  const root = tempRoot('kcw-art-version-route-');
  const parent = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_route_v1',
    owner: ALICE_IDENTITY,
    viz: table(1),
  });
  buildLiveArtifactVersion({
    trustedRoot: root,
    parentVersionId: parent.id,
    id: 'viz_route_v2',
    context: ALICE_IDENTITY,
    viz: table(2),
  });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    authStore: siblingAuthStore(),
  });
  const base = await bind(server);
  try {
    const alice = await jsonRequest(base, '/api/artifacts/live/viz_route_v2/history', { headers: ALICE_HEADERS });
    assert.equal(alice.status, 200);
    assert.equal('context' in alice.body, false);
    assert.deepEqual(
      new Set((alice.body.versions as Array<{ id: string }>).map((version) => version.id)),
      new Set(['viz_route_v1', 'viz_route_v2']),
    );

    const bob = await jsonRequest(base, '/api/artifacts/live/viz_route_v2/history', { headers: BOB_HEADERS });
    assert.equal(bob.status, 404);
    const invalid = await jsonRequest(base, '/api/artifacts/live/bad%2Fid/history', { headers: ALICE_HEADERS });
    assert.equal(invalid.status, 400);

    const post = await jsonRequest(base, '/api/artifacts/live/viz_route_v2/history', {
      method: 'POST',
      headers: ALICE_HEADERS,
      body: {},
    });
    assert.equal(post.status, 404);
  } finally {
    await close(server);
  }
});
