import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ensureArtifactOwnerClaim } from '../src/artifacts/artifact-owner.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';

const TENANT = 'tenant_shared';
const ALICE_OWNER = Object.freeze({ tenantId: TENANT, userId: 'alice' });
const BOB_OWNER = Object.freeze({ tenantId: TENANT, userId: 'bob' });
const ALICE = Object.freeze({ authorization: 'Bearer alice-token' });

function authStore() {
  return {
    resolveToken(token: string) {
      if (token === 'alice-token') return ALICE_OWNER;
      if (token === 'bob-token') return BOB_OWNER;
      return null;
    },
  };
}

function viz(label: string): Record<string, unknown> {
  return { viz: { kind: 'table', data: { columns: ['secret'], rows: [[label]] } } };
}

async function persistLiveSource(
  base: string,
  id: string,
  sourcePath: string,
): Promise<void> {
  const body = {
    id,
    title: id,
    kind: 'table',
    data: { columns: ['secret'], rows: [['initial']] },
    dataSource: { type: 'file-json', path: sourcePath },
  };
  const preview = await jsonRequest(base, '/api/viz/render/preview', {
    method: 'POST',
    headers: ALICE,
    body,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const rendered = await jsonRequest(base, '/api/viz/render', {
    method: 'POST',
    headers: { ...ALICE, 'idempotency-key': `persist-${id}` },
    body: {
      ...body,
      id: stringField(preview.body, 'id'),
      fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
    },
  });
  assert.equal(rendered.status, 200, JSON.stringify(rendered.body));
}

test('live file-json refresh enforces source ownership before reading bytes', async () => {
  const trustedRoot = tempRoot('kcw-live-source-owner-');
  const artifactRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts');
  const bobSource = path.join(artifactRoot, 'bob-source.json');
  const aliceSource = path.join(artifactRoot, 'alice-source.json');
  const ordinarySource = path.join(trustedRoot, 'data', 'ordinary-source.json');
  fs.mkdirSync(path.dirname(bobSource), { recursive: true });
  fs.mkdirSync(path.dirname(ordinarySource), { recursive: true });
  ensureArtifactOwnerClaim({ trustedRoot, artifactPath: bobSource, owner: BOB_OWNER });
  ensureArtifactOwnerClaim({ trustedRoot, artifactPath: aliceSource, owner: ALICE_OWNER });
  fs.writeFileSync(bobSource, JSON.stringify(viz('BOB_ONLY')), 'utf8');
  fs.writeFileSync(aliceSource, JSON.stringify(viz('ALICE_ONLY')), 'utf8');
  fs.writeFileSync(ordinarySource, JSON.stringify(viz('ORDINARY_OK')), 'utf8');

  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: true,
    authStore: authStore(),
  });
  const base = await bind(server);
  try {
    await persistLiveSource(base, 'viz_bob_sibling_source', path.relative(trustedRoot, bobSource));
    await persistLiveSource(base, 'viz_alice_own_source', path.relative(trustedRoot, aliceSource));
    await persistLiveSource(base, 'viz_ordinary_source', path.relative(trustedRoot, ordinarySource));

    const denied = await jsonRequest(base, '/api/artifacts/data/viz_bob_sibling_source', { headers: ALICE });
    assert.equal(denied.status, 404);
    assert.doesNotMatch(JSON.stringify(denied.body), /BOB_ONLY/);

    const own = await jsonRequest(base, '/api/artifacts/data/viz_alice_own_source', { headers: ALICE });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.match(JSON.stringify(own.body), /ALICE_ONLY/);

    const ordinary = await jsonRequest(base, '/api/artifacts/data/viz_ordinary_source', { headers: ALICE });
    assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
    assert.match(JSON.stringify(ordinary.body), /ORDINARY_OK/);
  } finally {
    await close(server);
  }
});
