import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createAesGcmProtector } from '../src/security/credential-store.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';

const ALICE = Object.freeze({ tenantId: 'tenant_shared', userId: 'alice' });
const ALICE_HEADERS = Object.freeze({ authorization: 'Bearer alice-token' });

test('revoked folder grants cannot replay cached file apply or rollback responses', async () => {
  const trustedRoot = tempRoot('kcw-file-ops-grant-replay-');
  const connectedRoot = path.join(trustedRoot, 'connected');
  fs.mkdirSync(connectedRoot);
  const server = createServer({
    trustedRoot,
    folderGrantStorePath: path.join(trustedRoot, '.AgentCowork', 'file-operation-folder-grants.json'),
    folderGrantProtector: createAesGcmProtector({ keyMaterial: 'test-file-operation-folder-grant-kek' }),
    enableScheduler: false,
    requireAuth: true,
    authStore: {
      resolveToken(token: string) {
        return token === 'alice-token' ? ALICE : null;
      },
    },
  });
  const base = await bind(server);
  try {
    const created = await jsonRequest(base, '/api/folder-grants', {
      method: 'POST',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'file-operation-grant-create' },
      body: { path: connectedRoot },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const grantId = stringField(created.body.grant as Record<string, unknown>, 'id');
    const grantHeaders = { ...ALICE_HEADERS, 'x-workspace-grant-id': grantId };
    const operations = [{
      type: 'write',
      path: path.join(connectedRoot, 'replay.txt'),
      content: 'approved content',
    }];
    const preview = await jsonRequest(base, '/api/file-ops/preview', {
      method: 'POST', headers: grantHeaders, body: { trustedRoot: connectedRoot, operations },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const applyBody = {
      trustedRoot: connectedRoot,
      operations,
      fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
    };
    const applied = await jsonRequest(base, '/api/file-ops/apply', {
      method: 'POST',
      headers: { ...grantHeaders, 'idempotency-key': 'file-operation-apply' },
      body: applyBody,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const rollbackBody = {
      trustedRoot: connectedRoot,
      applied: applied.body.applied,
      rollbackApprovalId: stringField(applied.body, 'rollbackApprovalId'),
    };
    const rolledBack = await jsonRequest(base, '/api/file-ops/rollback', {
      method: 'POST',
      headers: { ...grantHeaders, 'idempotency-key': 'file-operation-rollback' },
      body: rollbackBody,
    });
    assert.equal(rolledBack.status, 200, JSON.stringify(rolledBack.body));

    const revoked = await jsonRequest(base, '/api/folder-grants/' + grantId, {
      method: 'DELETE',
      headers: { ...ALICE_HEADERS, 'idempotency-key': 'file-operation-grant-revoke' },
      body: {},
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

    for (const [route, key, body] of [
      ['/api/file-ops/apply', 'file-operation-apply', applyBody],
      ['/api/file-ops/rollback', 'file-operation-rollback', rollbackBody],
    ] as const) {
      const replay = await jsonRequest(base, route, {
        method: 'POST',
        headers: { ...grantHeaders, 'idempotency-key': key },
        body,
      });
      assert.equal(replay.status, 403, JSON.stringify(replay.body));
    }
  } finally {
    await close(server);
  }
});
