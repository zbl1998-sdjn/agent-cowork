import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer({ requireAuth: false, ...config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('prompt refine route returns visible missing fields instead of rewriting vague intent', async () => {
  const trustedRoot = makeTestWorkspace('prompt-refine');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/prompt/refine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '帮我处理一下', trustedRoot }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.changed, false);
    assert.equal(body.refined, '帮我处理一下');
    assert.deepEqual(body.missing, ['action', 'target', 'desiredOutput']);
    assert.equal(body.trustedRoot, trustedRoot);
  });
});

test('prompt refine route can use an injected refiner and preserves request identity', async () => {
  const trustedRoot = makeTestWorkspace('prompt-refine');
  let capturedContext;
  await withServer({
    trustedRoot,
    promptRefiner: {
      async refine(raw, ctx) {
        capturedContext = ctx;
        return {
          refined: `${raw}\n请给出验证命令。`,
          changed: true,
          intent: 'review',
          missing: [],
        };
      },
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/prompt/refine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: '检查测试计划',
        trustedRoot,
        context: { project: 'Agent Cowork' },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.changed, true);
    assert.match(body.refined, /验证命令/);
    assert.equal(body.context.tenantId, 'tenant_local');
    assert.equal(capturedContext.project, 'Agent Cowork');
    assert.equal(capturedContext.trustedRoot, trustedRoot);
    assert.equal(capturedContext.tenantId, 'tenant_local');
  });
});

test('prompt refine route injects recalled user profile into refinement context', async () => {
  const trustedRoot = makeTestWorkspace('prompt-refine-profile');
  let capturedContext;
  await withServer({
    trustedRoot,
    promptRefiner: {
      async refine(raw, ctx) {
        capturedContext = ctx;
        return {
          refined: raw,
          changed: false,
          intent: 'review',
          missing: [],
        };
      },
    },
  }, async (baseUrl) => {
    const learn = await fetch(`${baseUrl}/api/memory/profile/learn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trustedRoot,
        type: 'term',
        key: 'FE',
        value: '前端体验验收',
        evidence: '用户确认',
      }),
    });
    assert.equal(learn.status, 200);

    const response = await fetch(`${baseUrl}/api/prompt/refine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '继续 FE 验收', trustedRoot }),
    });

    assert.equal(response.status, 200);
    assert.ok(capturedContext.profile.terms.includes('FE = 前端体验验收'));
    assert.equal(capturedContext.trustedRoot, trustedRoot);
  });
});
