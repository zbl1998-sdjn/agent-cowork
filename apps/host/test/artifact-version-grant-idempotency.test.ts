import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildLiveArtifact } from '../src/artifacts/live-artifact.js';
import { createAesGcmProtector } from '../src/security/credential-store.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const ALICE_HEADERS = Object.freeze({ authorization: 'Bearer alice-token' });

function authStore() {
  return {
    resolveToken(token: string) {
      return token === 'alice-token' ? ALICE : null;
    },
  };
}

test('revoked folder grants cannot replay a cached artifact version publication', async () => {
  const trustedRoot = tempRoot('kcw-art-version-grant-replay-');
  const connectedRoot = path.join(trustedRoot, 'connected');
  fs.mkdirSync(connectedRoot);
  const parent = buildLiveArtifact({
    trustedRoot: connectedRoot,
    id: 'viz_grant_parent_v1',
    owner: ALICE,
    viz: { kind: 'table', data: { columns: ['value'], rows: [[1]] } },
  });
  const server = createServer({
    trustedRoot,
    folderGrantStorePath: path.join(trustedRoot, '.AgentCowork', 'artifact-folder-grants.json'),
    folderGrantProtector: createAesGcmProtector({ keyMaterial: 'test-artifact-folder-grant-kek' }),
    enableScheduler: false,
    requireAuth: true,
    authStore: authStore(),
  });
  const base = await bind(server);
  try {
    const created = await jsonRequest(base, '/api/folder-grants', {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-grant-create' },
      body: { path: connectedRoot },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const grantId = stringField(created.body.grant as Record<string, unknown>, 'id');
    const grantHeaders = { ...ALICE_HEADERS, 'x-workspace-grant-id': grantId };
    const draft = {
      trustedRoot: connectedRoot,
      id: 'viz_grant_child_v2',
      viz: { kind: 'table', data: { columns: ['value'], rows: [[2]] } },
    };
    const preview = await jsonRequest(base, '/api/artifacts/live/' + parent.id + '/versions/preview', {
      method: 'POST', headers: grantHeaders, body: draft,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const publishBody = {
      ...draft,
      fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
    };
    const first = await jsonRequest(base, '/api/artifacts/live/' + parent.id + '/versions', {
      method: 'POST',
      headers: { ...grantHeaders, 'idempotency-key': 'artifact-grant-publish' },
      body: publishBody,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const revoked = await jsonRequest(base, '/api/folder-grants/' + grantId, {
      method: 'DELETE',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'artifact-grant-revoke' },
      body: {},
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

    const replay = await jsonRequest(base, '/api/artifacts/live/' + parent.id + '/versions', {
      method: 'POST',
      headers: { ...grantHeaders, 'idempotency-key': 'artifact-grant-publish' },
      body: publishBody,
    });
    assert.equal(replay.status, 403, JSON.stringify(replay.body));
  } finally {
    await close(server);
  }
});
