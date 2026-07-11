import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createAesGcmProtector } from '../src/security/credential-store.js';
import { createServer } from '../src/server.js';
import {
  bind,
  close,
  jsonRequest,
  recordArray,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

test('connected-folder grant authorizes an owner path and revoke denies later requests', async () => {
  const trustedRoot = tempRoot('kcw-folder-grants-root-');
  const connectedRoot = path.join(trustedRoot, 'connected');
  const internalRoot = path.join(trustedRoot, '.AgentCowork', 'not-a-workspace');
  const folderGrantStorePath = path.join(trustedRoot, '.AgentCowork', 'test-folder-grants.json');
  fs.mkdirSync(connectedRoot);
  fs.mkdirSync(internalRoot, { recursive: true });
  const server = createServer({
    trustedRoot,
    folderGrantStorePath,
    folderGrantProtector: createAesGcmProtector({ keyMaterial: 'test-folder-grant-http-kek' }),
    requireAuth: false,
    persistAuth: false,
    rateLimit: false,
    enableScheduler: false,
  });
  const base = await bind(server);
  try {
    const created = await jsonRequest(base, '/api/folder-grants', {
      method: 'POST',
      headers: { 'idempotency-key': 'folder-grant-create-1' },
      body: { path: connectedRoot, displayName: 'Connected' },
    });
    assert.equal(created.status, 201);
    const grant = created.body.grant as Record<string, unknown>;
    const grantId = stringField(grant, 'id');
    assert.equal(grant.path, connectedRoot);
    assert.equal(grant.revokedAt, null);

    const duplicate = await jsonRequest(base, '/api/folder-grants', {
      method: 'POST',
      headers: { 'idempotency-key': 'folder-grant-create-duplicate' },
      body: { path: connectedRoot, displayName: 'Duplicate' },
    });
    assert.equal(duplicate.status, 201);
    assert.equal(stringField(duplicate.body.grant as Record<string, unknown>, 'id'), grantId);
    const activeList = await jsonRequest(base, '/api/folder-grants');
    assert.equal(
      recordArray(activeList.body.grants, 'active grants').filter((item) => item.path === connectedRoot).length,
      1,
    );

    for (const [index, rejectedPath] of [path.dirname(trustedRoot), internalRoot].entries()) {
      const rejected = await jsonRequest(base, '/api/folder-grants', {
        method: 'POST',
        headers: { 'idempotency-key': `folder-grant-reject-${index}` },
        body: { path: rejectedPath },
      });
      assert.equal(rejected.status, 400);
    }

    const deniedWithoutGrant = await jsonRequest(
      base,
      `/api/projects?trustedRoot=${encodeURIComponent(connectedRoot)}`,
    );
    assert.equal(deniedWithoutGrant.status, 403);
    const deniedWrongGrant = await jsonRequest(
      base,
      `/api/projects?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      { headers: { 'x-workspace-grant-id': 'grant_unknown' } },
    );
    assert.equal(deniedWrongGrant.status, 403);

    for (const route of [
      `/api/conversations?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      `/api/memory/settings?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      `/api/memory/knowledge?trustedRoot=${encodeURIComponent(connectedRoot)}`,
    ]) {
      const deniedRoute = await jsonRequest(base, route);
      assert.equal(deniedRoute.status, 403, `${route} must require the connected-folder grant`);
    }

    const allowed = await jsonRequest(
      base,
      `/api/projects?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      { headers: { 'x-workspace-grant-id': grantId } },
    );
    assert.equal(allowed.status, 200);

    for (const route of [
      `/api/conversations?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      `/api/memory/settings?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      `/api/memory/knowledge?trustedRoot=${encodeURIComponent(connectedRoot)}`,
    ]) {
      const allowedRoute = await jsonRequest(base, route, {
        headers: { 'x-workspace-grant-id': grantId },
      });
      assert.equal(allowedRoute.status, 200, `${route} must accept the active connected-folder grant`);
    }

    const revoked = await jsonRequest(base, `/api/folder-grants/${encodeURIComponent(grantId)}`, {
      method: 'DELETE',
      headers: { 'idempotency-key': 'folder-grant-revoke-1' },
      body: {},
    });
    assert.equal(revoked.status, 200);
    assert.equal((revoked.body.grant as Record<string, unknown>).id, grantId);
    const tombstones = await jsonRequest(base, '/api/folder-grants?includeRevoked=1');
    const revokedGrant = recordArray(tombstones.body.grants, 'all grants')
      .find((item) => item.id === grantId);
    assert.equal(revokedGrant?.status, 'revoked');
    assert.equal(typeof revokedGrant?.revokedAt, 'string');

    const deniedAfterRevoke = await jsonRequest(
      base,
      `/api/projects?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      { headers: { 'x-workspace-grant-id': grantId } },
    );
    assert.equal(deniedAfterRevoke.status, 403);

    const defaultRootCompatibility = await jsonRequest(base, '/api/projects');
    assert.equal(defaultRootCompatibility.status, 200);
  } finally {
    await close(server);
  }
});

test('connected-folder grants are isolated by authenticated owner', async () => {
  const trustedRoot = tempRoot('kcw-folder-grants-owner-');
  const connectedRoot = path.join(trustedRoot, 'connected');
  fs.mkdirSync(connectedRoot);
  const server = createServer({
    trustedRoot,
    folderGrantStorePath: path.join(trustedRoot, '.AgentCowork', 'owner-folder-grants.json'),
    folderGrantProtector: createAesGcmProtector({ keyMaterial: 'test-folder-grant-owner-kek' }),
    requireAuth: true,
    trustIdentityHeaders: true,
    persistAuth: false,
    rateLimit: false,
    enableScheduler: false,
  });
  const base = await bind(server);
  const ownerA = { 'x-tenant-id': 'tenant-folder-a', 'x-user-id': 'user-folder-a' };
  const ownerB = { 'x-tenant-id': 'tenant-folder-b', 'x-user-id': 'user-folder-b' };
  try {
    const created = await jsonRequest(base, '/api/folder-grants', {
      method: 'POST',
      headers: { ...ownerA, 'idempotency-key': 'folder-grant-owner-create' },
      body: { path: connectedRoot },
    });
    assert.equal(created.status, 201);
    const grantId = stringField(created.body.grant as Record<string, unknown>, 'id');

    const listAsB = await jsonRequest(base, '/api/folder-grants', { headers: ownerB });
    assert.equal(recordArray(listAsB.body.grants, 'owner B grants').some((item) => item.id === grantId), false);

    const revokeAsB = await jsonRequest(base, `/api/folder-grants/${grantId}`, {
      method: 'DELETE',
      headers: { ...ownerB, 'idempotency-key': 'folder-grant-owner-revoke' },
      body: {},
    });
    assert.equal(revokeAsB.status, 404);

    const useAsB = await jsonRequest(
      base,
      `/api/conversations?trustedRoot=${encodeURIComponent(connectedRoot)}`,
      { headers: { ...ownerB, 'x-workspace-grant-id': grantId } },
    );
    assert.equal(useAsB.status, 403);
  } finally {
    await close(server);
  }
});
