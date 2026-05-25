import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { createRunId } from '../src/runtime/run-store.js';
import { createUlid } from '../src/runtime/runs-index.js';
import { createSeededIdSource } from '../src/util/ids.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-seeded-ids-'));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
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
  const expectedSource = createSeededIdSource(seed);
  const expectedRunId = createRunId(expectedSource.date(), { randomHex: expectedSource.randomHex });
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    kimiChatRunner: async () => ({}),
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
    await new Promise((resolve) => server.close(resolve));
  }
});
