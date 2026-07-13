import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runModelApiChatStream } from '../src/engine/api-runner.js';
import { createKimiRefineModelCall } from '../src/engine/prompt/refine-model-call.js';
import { createServer } from '../src/server.js';
import { isEgressAuditFailure } from '../src/security/egress-gateway.js';
import { makeTestWorkspace } from './test-fixtures.js';

type ServerConfig = Parameters<typeof createServer>[0];

const LOCAL_MODEL = {
  provider: 'openai/local',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'audit-test-model',
  securityMode: 'local_strict',
  apiKey: 'dummy-local-model-key',
} as const;

function blockAuditSink(trustedRoot: string): void {
  const sink = path.join(trustedRoot, '.AgentCowork', 'security', 'egress-audit.jsonl');
  fs.mkdirSync(sink, { recursive: true });
}

async function withServer(config: ServerConfig, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer({ requireAuth: false, enableScheduler: false, ...config });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Kimi plan and prompt-refine routes never fetch when audit persistence fails', async () => {
  const trustedRoot = makeTestWorkspace('egress-api-route');
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('model fetch must not run');
  };
  const promptRefineModelCall = createKimiRefineModelCall({
    modelConfig: LOCAL_MODEL,
    fetchImpl: fetchImpl as never,
  });

  await withServer({
    trustedRoot,
    securityMode: LOCAL_MODEL.securityMode,
    kimiProvider: LOCAL_MODEL.provider,
    kimiBaseUrl: LOCAL_MODEL.baseUrl,
    kimiModel: LOCAL_MODEL.model,
    kimiApiKey: LOCAL_MODEL.apiKey,
    fetchImpl,
    promptRefineModelCall,
  }, async (baseUrl) => {
    blockAuditSink(trustedRoot);
    const plan = await fetch(`${baseUrl}/api/agent-engine/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '生成审计计划', trustedRoot }),
    });
    assert.equal(plan.status, 500);
    assert.equal(fetchCalls, 0, 'plan route must persist its audit record before model fetch');

    const refine = await fetch(`${baseUrl}/api/prompt/refine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '分析当前项目测试覆盖薄弱点', trustedRoot }),
    });
    assert.equal(refine.status, 500);
    assert.equal(fetchCalls, 0, 'prompt route must propagate audit failure before model fetch');
  });
});

test('streaming Kimi runner never fetches when audit persistence fails', async () => {
  const trustedRoot = makeTestWorkspace('egress-api-stream');
  blockAuditSink(trustedRoot);
  let fetchCalls = 0;

  await assert.rejects(
    () => runModelApiChatStream({
      ...LOCAL_MODEL,
      trustedRoot,
      prompt: 'stream without audit bypass',
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('model fetch must not run');
      }) as never,
    }),
    isEgressAuditFailure,
  );
  assert.equal(fetchCalls, 0);
});
