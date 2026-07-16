import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
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

test('E2E ollama-cloud: recommended lists cloud models; pull rejects injection before spawning', async () => {
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, trustedRoot: tempRoot('acw-ollama-'), enableScheduler: false, requireAuth: false });
  const base = await bind(server);
  try {
    const rec = await J(base, '/api/ollama-cloud/recommended');
    assert.equal(rec.status, 200);
    const models = rec.body.models as string[];
    assert.ok(Array.isArray(models) && models.length > 0);
    assert.ok(models.every((m) => m.endsWith('-cloud') || m.endsWith(':cloud')), 'all recommendations are cloud models');

    // injection / non-cloud names are refused with 400 before any process spawn
    for (const bad of ['evil; rm -rf /:cloud', '$(whoami):cloud', 'qwen2.5:0.5b', '']) {
      const res = await J(base, '/api/ollama-cloud/pull', { method: 'POST', body: { model: bad } });
      assert.equal(res.status, 400, `must reject: ${bad}`);
    }
  } finally {
    await close(server);
  }
});
