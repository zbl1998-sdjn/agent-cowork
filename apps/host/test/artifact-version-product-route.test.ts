import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildLiveArtifact, readArtifactManifest } from '../src/artifacts/live-artifact.js';
import { artifactPaths } from '../src/artifacts/live-spec.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const ALICE_HEADERS = Object.freeze({ authorization: 'Bearer alice-token' });
const BOB_HEADERS = Object.freeze({ authorization: 'Bearer bob-token' });

function table(value: number) {
  return { kind: 'table', data: { columns: ['value'], rows: [[value]] } };
}

function authStore() {
  return {
    resolveToken(token: string) {
      if (token === 'alice-token') return ALICE;
      if (token === 'bob-token') return { tenantId: 'tenant_shared', userId: 'bob' };
      return null;
    },
  };
}

test('product route publishes an approved immutable version and replays it idempotently', async () => {
  const root = tempRoot('kcw-art-version-product-');
  const parent = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_product_v1',
    owner: ALICE,
    title: 'Quarterly report',
    viz: table(1),
  });
  const parentHtml = fs.readFileSync(parent.htmlPath, 'utf8');
  const parentManifest = fs.readFileSync(parent.manifestPath, 'utf8');
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    authStore: authStore(),
  });
  const base = await bind(server);
  try {
    const draft = { title: 'Quarterly report v2', viz: table(2) };
    const preview = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions/preview`, {
      method: 'POST',
      headers: ALICE_HEADERS,
      body: draft,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.title, draft.title);
    assert.equal(preview.body.vizKind, 'table');
    assert.equal(preview.body.dataSourceType, 'inline');
    assert.equal(preview.body.parentContentSha256, readArtifactManifest({
      trustedRoot: root,
      id: parent.id,
      context: ALICE,
    }).contentSha256);
    assert.equal(preview.body.operationCount, 2);
    assert.match(stringField(preview.body, 'approvalPlanSha256'), /^[a-f0-9]{64}$/);
    const id = stringField(preview.body, 'id');
    const approvalId = stringField(preview.body, 'fileOperationApprovalId');
    const childPaths = artifactPaths({ trustedRoot: root, id });
    assert.equal(fs.existsSync(childPaths.htmlPath), false);
    assert.equal(fs.existsSync(childPaths.manifestPath), false);

    const body = { ...draft, id, fileOperationApprovalId: approvalId };
    const first = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions`, {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-version-product-1' },
      body,
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.id, id);
    assert.equal(first.body.parentVersionId, parent.id);
    const childManifest = readArtifactManifest({ trustedRoot: root, id, context: ALICE });
    assert.equal(childManifest.parentVersionId, parent.id);
    assert.equal(childManifest.lineageId, parent.id);
    assert.equal(fs.readFileSync(parent.htmlPath, 'utf8'), parentHtml);
    assert.equal(fs.readFileSync(parent.manifestPath, 'utf8'), parentManifest);

    const replay = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions`, {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-version-product-1' },
      body,
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, id);
    assert.equal(replay.body.idempotentReplay, true);

    const mismatch = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions`, {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-version-product-1' },
      body: { ...body, title: 'different request' },
    });
    assert.equal(mismatch.status, 409);
  } finally {
    await close(server);
  }
});

test('product route fails closed across approval, owner, and exact-operation boundaries', async () => {
  const root = tempRoot('kcw-art-version-boundary-');
  const parent = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_boundary_v1',
    owner: ALICE,
    viz: table(1),
  });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    authStore: authStore(),
  });
  const base = await bind(server);
  try {
    const hidden = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions/preview`, {
      method: 'POST',
      headers: BOB_HEADERS,
      body: { viz: table(2) },
    });
    assert.equal(hidden.status, 404);

    const missingId = 'viz_boundary_missing_approval';
    const missing = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions`, {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-version-missing' },
      body: { id: missingId, viz: table(2) },
    });
    assert.equal(missing.status, 428);
    assert.equal(fs.existsSync(artifactPaths({ trustedRoot: root, id: missingId }).htmlPath), false);

    const draft = { id: 'viz_boundary_exact_v2', viz: table(2) };
    const preview = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions/preview`, {
      method: 'POST',
      headers: ALICE_HEADERS,
      body: draft,
    });
    assert.equal(preview.status, 200);
    const changed = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions`, {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-version-changed' },
      body: {
        ...draft,
        viz: table(3),
        fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
      },
    });
    assert.equal(changed.status, 403);
    assert.equal(fs.existsSync(artifactPaths({ trustedRoot: root, id: draft.id }).htmlPath), false);
  } finally {
    await close(server);
  }
});

test('parent hash is rechecked after preview and before any version write', async () => {
  const root = tempRoot('kcw-art-version-race-');
  const parent = buildLiveArtifact({
    trustedRoot: root,
    id: 'viz_race_v1',
    owner: ALICE,
    viz: table(1),
  });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    authStore: authStore(),
  });
  const base = await bind(server);
  try {
    const draft = { id: 'viz_race_v2', viz: table(2) };
    const preview = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions/preview`, {
      method: 'POST',
      headers: ALICE_HEADERS,
      body: draft,
    });
    assert.equal(preview.status, 200);
    fs.appendFileSync(parent.htmlPath, '\n<!-- tampered after preview -->\n', 'utf8');

    const published = await jsonRequest(base, `/api/artifacts/live/${parent.id}/versions`, {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-version-race' },
      body: {
        ...draft,
        fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
      },
    });
    assert.equal(published.status, 409);
    const childPaths = artifactPaths({ trustedRoot: root, id: draft.id });
    assert.equal(fs.existsSync(childPaths.htmlPath), false);
    assert.equal(fs.existsSync(childPaths.manifestPath), false);
  } finally {
    await close(server);
  }
});
