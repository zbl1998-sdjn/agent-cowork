import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ModelTextResult } from '../src/engine/api-runner.js';
import type { HostServer } from '../src/server.js';
import { createServer } from '../src/server.js';
import { createRunId } from '../src/runtime/run-store.js';
import { createUlid } from '../src/runtime/runs-index.js';
import { createSeededIdSource } from '../src/util/ids.js';
import { closeTestServer } from './helpers/close-server.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-seeded-ids-'));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function fakeKimiChatRunner(): Promise<ModelTextResult> {
  return { ok: true, provider: 'test', model: 'test', mode: 'chat', text: 'ok', durationMs: 0 };
}

test('seeded id source makes run ids and ULIDs reproducible', () => {
  const left = createSeededIdSource('trace-seed');
  const right = createSeededIdSource('trace-seed');
  const leftDate = left.date();
  const rightDate = right.date();

  assert.equal(leftDate.toISOString(), rightDate.toISOString());
  assert.equal(
    createRunId(leftDate, { randomHex: left.randomHex }),
    createRunId(rightDate, { randomHex: right.randomHex }),
  );
  assert.equal(
    createUlid(leftDate.getTime(), { randomBytes: left.randomBytes }),
    createUlid(rightDate.getTime(), { randomBytes: right.randomBytes }),
  );
});

test('agent stream runSeed emits a deterministic start runId', async () => {
  const root = tempRoot();
  const seed = 'agent-replay-1';
  const expectedSource = createSeededIdSource(JSON.stringify(['tenant_local', 'user_local', seed]));
  const expectedRunId = createRunId(expectedSource.date(), { randomHex: expectedSource.randomHex });
  const server = createServer({
    ...TEST_LOCAL_HOST_MODEL_CONFIG,
    requireAuth: false,
    trustedRoot: root,
    enableScheduler: false,
    modelChatRunner: fakeKimiChatRunner,
    agentModelCall: async () => ({ content: 'seeded done' }),
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'seeded', runSeed: seed }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, new RegExp(`"runId":"${expectedRunId}"`));
    assert.match(text, /seeded done/);
  } finally {
    await closeTestServer(server);
  }
});
