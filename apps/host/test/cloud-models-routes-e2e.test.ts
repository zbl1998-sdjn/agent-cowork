import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { decideModelProviderPolicy } from '../src/security/security-mode.js';
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

test('E2E cloud-models: enabling a provider persists and flips the egress gate via env sync', async () => {
  const prevEnv = process.env.ACW_CUSTOMER_MODEL_GATEWAY_HOSTS;
  delete process.env.ACW_CUSTOMER_MODEL_GATEWAY_HOSTS;
  const root = tempRoot('acw-cloud-');
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, trustedRoot: root, enableScheduler: false, requireAuth: false });
  const base = await bind(server);
  try {
    const initial = await J(base, '/api/cloud-models');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.enabled, false);
    assert.ok(Array.isArray(initial.body.available) && (initial.body.available as unknown[]).length > 0, 'offers cloud providers');

    // before enabling: deepseek is not allowed
    const dsConfig = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4' };
    assert.notEqual(decideModelProviderPolicy(dsConfig, { securityMode: 'controlled_hybrid' }).decision, 'allow');

    const on = await J(base, '/api/cloud-models', { method: 'POST', body: { enabled: true, providers: ['deepseek'] } });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);
    assert.deepEqual(on.body.providers, ['deepseek']);
    assert.match(fs.readFileSync(path.join(root, '.AgentCowork', 'settings', 'cloud-models.json'), 'utf8'), /deepseek/);

    // route synced process.env -> policy now allows deepseek
    assert.equal(decideModelProviderPolicy(dsConfig, { securityMode: 'controlled_hybrid' }).decision, 'allow');

    // toggling off restores the block
    await J(base, '/api/cloud-models', { method: 'POST', body: { enabled: false, providers: ['deepseek'] } });
    assert.notEqual(decideModelProviderPolicy(dsConfig, { securityMode: 'controlled_hybrid' }).decision, 'allow');

    const bad = await J(base, '/api/cloud-models', { method: 'POST', body: { enabled: true, providers: ['ollama'] } });
    assert.equal(bad.status, 400);
  } finally {
    await close(server);
    if (prevEnv === undefined) delete process.env.ACW_CUSTOMER_MODEL_GATEWAY_HOSTS;
    else process.env.ACW_CUSTOMER_MODEL_GATEWAY_HOSTS = prevEnv;
  }
});
