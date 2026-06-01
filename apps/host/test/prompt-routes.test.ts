import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:http';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

type ServerConfig = Parameters<typeof createServer>[0];
type PromptContext = Record<string, unknown> & {
  profile?: { terms: string[] };
  project?: string;
  tenantId?: string;
  trustedRoot?: string;
};
type PromptRefineResult = {
  refined: string;
  changed: boolean;
  intent: string;
  missing: string[];
};
type PromptRefineBody = PromptRefineResult & {
  context: { tenantId: string };
  trustedRoot: string;
};

async function withServer(config: ServerConfig, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer({ requireAuth: false, ...config });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address !== null);
  assert.equal(typeof address, 'object');
  const { port } = address as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const body = await response.json() as PromptRefineBody;
    assert.equal(body.changed, false);
    assert.equal(body.refined, '帮我处理一下');
    assert.deepEqual(body.missing, ['action', 'target', 'desiredOutput']);
    assert.equal(body.trustedRoot, trustedRoot);
  });
});

test('prompt refine route can use an injected refiner and preserves request identity', async () => {
  const trustedRoot = makeTestWorkspace('prompt-refine');
  let capturedContext: PromptContext | undefined;
  await withServer({
    trustedRoot,
    promptRefiner: {
      async refine(raw: string, ctx: PromptContext): Promise<PromptRefineResult> {
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
    const body = await response.json() as PromptRefineBody;
    assert.equal(body.changed, true);
    assert.match(body.refined, /验证命令/);
    assert.equal(body.context.tenantId, 'tenant_local');
    assert.ok(capturedContext);
    assert.equal(capturedContext.project, 'Agent Cowork');
    assert.equal(capturedContext.trustedRoot, trustedRoot);
    assert.equal(capturedContext.tenantId, 'tenant_local');
  });
});

test('prompt refine route rejects malformed required prompt and normalizes optional context', async () => {
  const trustedRoot = makeTestWorkspace('prompt-refine-normalize');
  let capturedRaw: string | undefined;
  let capturedContext: PromptContext | undefined;
  await withServer({
    trustedRoot,
    promptRefiner: {
      async refine(raw: string, ctx: PromptContext): Promise<PromptRefineResult> {
        capturedRaw = raw;
        capturedContext = ctx;
        return {
          refined: String(raw),
          changed: false,
          intent: 'unknown',
          missing: [],
        };
      },
    },
  }, async (baseUrl) => {
    const invalidPrompt = await fetch(`${baseUrl}/api/prompt/refine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: ['bad'], trustedRoot, context: ['not-object'] }),
    });

    assert.equal(invalidPrompt.status, 400);
    assert.equal(capturedRaw, undefined);

    const response = await fetch(`${baseUrl}/api/prompt/refine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '继续优化', trustedRoot, context: ['not-object'] }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedRaw, '继续优化');
    assert.ok(capturedContext);
    assert.equal(capturedContext.trustedRoot, trustedRoot);
    assert.equal(capturedContext.tenantId, 'tenant_local');
    assert.equal(Object.hasOwn(capturedContext, '0'), false);
  });
});

test('prompt refine route injects recalled user profile into refinement context', async () => {
  const trustedRoot = makeTestWorkspace('prompt-refine-profile');
  let capturedContext: PromptContext | undefined;
  await withServer({
    trustedRoot,
    promptRefiner: {
      async refine(raw: string, ctx: PromptContext): Promise<PromptRefineResult> {
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
    assert.ok(capturedContext?.profile);
    assert.ok(capturedContext.profile.terms.includes('FE = 前端体验验收'));
    assert.equal(capturedContext.trustedRoot, trustedRoot);
  });
});
