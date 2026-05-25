import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { buildRunMetrics } from '../src/runtime/run-metrics.js';
import { readRunRecord, writeRunRecord } from '../src/runtime/run-store.js';
import { closeTestServer } from './helpers/close-server.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-run-metrics-'));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('buildRunMetrics derives tokens, cost, duration, steps, tools, and failure rate', () => {
  const metrics = buildRunMetrics({
    id: 'run_metrics_unit',
    type: 'agent-chat',
    provider: 'kimi-api',
    model: 'moonshot-v1-8k',
    status: 'succeeded',
    startedAt: '2026-05-25T00:00:00.000Z',
    finishedAt: '2026-05-25T00:00:02.500Z',
    result: {
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      steps: [
        { tool: 'Read', ok: true },
        { tool: 'Write', status: 'failed', error: 'blocked' },
        { tool: 'Shell', ok: true },
      ],
    },
  });

  assert.equal(metrics.schemaVersion, 1);
  assert.equal(metrics.provider, 'kimi-api');
  assert.equal(metrics.cost.provider, 'kimi-api');
  assert.deepEqual(metrics.tokens, { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
  assert.equal(metrics.cost.total, 0.002595);
  assert.equal(metrics.duration.totalMs, 2500);
  assert.deepEqual(metrics.steps, { total: 3, succeeded: 2, failed: 1 });
  assert.deepEqual(metrics.tools, { calls: 3, succeeded: 2, failed: 1, unique: ['Read', 'Shell', 'Write'] });
  assert.deepEqual(metrics.failures, { count: 1, rate: 0.3333, runFailed: false });
});

test('writeRunRecord attaches structured metrics to every persisted run record', () => {
  const runStoreRoot = path.join(tempRoot(), 'runs');
  writeRunRecord(runStoreRoot, {
    id: 'run_metrics_persisted',
    type: 'subagent-run',
    provider: 'agent-cowork-host',
    status: 'succeeded',
    startedAt: '2026-05-25T00:00:00.000Z',
    durationMs: 1200,
    result: {
      ok: true,
      steps: [{ tool: 'SearchWorkspace', status: 'succeeded' }],
    },
  });

  const record = readRunRecord(runStoreRoot, 'run_metrics_persisted');
  assert.equal(record.metrics.schemaVersion, 1);
  assert.equal(record.metrics.duration.totalMs, 1200);
  assert.equal(record.metrics.tools.calls, 1);
  assert.equal(record.metrics.failures.rate, 0);
});

test('agent stream persists token usage metrics from the run outcome', async () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'note.md'), 'hello', 'utf8');
  let calls = 0;
  const agentModelCall = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: JSON.stringify({ path: 'note.md' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      };
    }
    return { content: '已读取 note.md。', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall });
  const base = await bind(server);

  try {
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '读 note.md', autoApprove: true }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: done/);

    const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
    const records = fs
      .readdirSync(runStoreRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(runStoreRoot, name), 'utf8')));
    const record = records.find((item) => item.type === 'agent-chat');
    assert.ok(record, 'agent-chat run record persisted');
    assert.equal(record.metrics.provider, 'kimi-api');
    assert.deepEqual(record.metrics.tokens, { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 });
    assert.equal(record.metrics.steps.total, 1);
    assert.equal(record.metrics.tools.calls, 1);
  } finally {
    await closeTestServer(server);
  }
});
