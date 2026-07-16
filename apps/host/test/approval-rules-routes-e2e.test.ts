import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { createWorkspaceApprovalRules } from '../src/runtime/approval-rules.js';
import { bind, close, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

async function J(base: string, route: string, opt: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, {
    method: opt.method || 'GET',
    headers: { 'content-type': 'application/json' },
    ...(opt.body === undefined ? {} : { body: JSON.stringify(opt.body) }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('E2E approval rules: list reflects persisted rules and remove revokes them', async () => {
  const root = tempRoot('acw-aprule-');
  createWorkspaceApprovalRules(root).add('Write');
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, trustedRoot: root, enableScheduler: false, requireAuth: false });
  const base = await bind(server);
  try {
    const list = await J(base, '/api/approval-rules');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.alwaysAllow, ['Write']);

    const removed = await J(base, '/api/approval-rules/Write/remove', { method: 'POST', body: {} });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.alwaysAllow, []);
    assert.deepEqual((await J(base, '/api/approval-rules')).body.alwaysAllow, []);

    const unknownTool = await J(base, '/api/approval-rules/*bad*/remove', { method: 'POST', body: {} });
    assert.equal(unknownTool.status, 404, 'names outside the tool-name shape never reach the handler');
  } finally {
    await close(server);
  }
});

test('E2E approval rules: a non-admin scoped user can manage their own workspace rules', async () => {
  const root = tempRoot('acw-aprule-guest-');
  createWorkspaceApprovalRules(root).add('Write');
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, trustedRoot: root, enableScheduler: false, requireAuth: true, trustIdentityHeaders: true });
  const base = await bind(server);
  try {
    const headers = { 'content-type': 'application/json', 'x-tenant-id': 'tenant_guest_1', 'x-user-id': 'guest_1' };
    const removed = await fetch(`${base}/api/approval-rules/Write/remove`, { method: 'POST', headers, body: '{}' });
    assert.equal(removed.status, 200, 'workspace-scoped settings must not require the global-mutation admin');
    assert.deepEqual(((await removed.json()) as { alwaysAllow?: unknown }).alwaysAllow, []);
  } finally {
    await close(server);
  }
});
