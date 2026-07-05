// P0 Orchestrator weekly-report 冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:在临时受信工作区拉起真实 Host HTTP 服务,通过 /api/orchestrator/run
//       启动 deterministic P0 weekly-report 编排,再回读 detail 断言 timeline/tasks/results。
// 用法:node scripts/run-host-node.mjs scripts/smoke-orchestrator-weekly-report.ts
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { HostServer } from '../apps/host/src/server.js';

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value: unknown, label: string): JsonRecord {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} should be an array`);
  return value;
}

async function listenLocal(server: HostServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'orchestrator smoke server did not bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: JsonRecord }> {
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : {};
  return { status: response.status, body: record(parsed, url) };
}

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(scriptDir);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-orchestrator-smoke-'));
  const weeklyPath = path.join(workspace, 'weekly.md');
  fs.writeFileSync(
    weeklyPath,
    [
      '# Weekly notes',
      '- Shipped typed P0 orchestrator runtime.',
      '- Added route integration and run-store persistence.',
      '- Pending UI Agent Team Timeline and async worker handoff.',
    ].join('\n'),
    'utf8',
  );

  const server = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    connectMcpOnStart: false,
    enableScheduler: false,
  });
  const baseUrl = await listenLocal(server);

  try {
    const requestBody = {
      workspaceRoot: workspace,
      userGoal: 'Create a concise weekly report from the provided notes.',
      recipeId: 'weekly-report',
      refs: [{
        refId: 'weekly-notes',
        kind: 'file',
        label: 'weekly.md',
        dataTags: ['internal'],
        text: fs.readFileSync(weeklyPath, 'utf8'),
        summary: 'Weekly notes for orchestrator smoke.',
        uri: `file://${weeklyPath}`,
      }],
    };
    const start = await fetchJson(`${baseUrl}/api/orchestrator/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `smoke-orchestrator-${Date.now()}`,
      },
      body: JSON.stringify(requestBody),
    });

    assert(start.status === 200, `/api/orchestrator/run returned ${start.status}: ${JSON.stringify(start.body)}`);
    assert(start.body.status === 'completed', 'orchestrator smoke run did not complete');
    assert(start.body.selectedRecipeId === 'weekly-report', 'orchestrator smoke selected the wrong recipe');
    const runId = String(start.body.runId || '');
    const detailUrl = String(start.body.detailUrl || '');
    const runPath = String(start.body.runPath || '');
    assert(/^run_/.test(runId), `unexpected run id: ${runId}`);
    assert(detailUrl === `/api/orchestrator/runs/${runId}`, `unexpected detail url: ${detailUrl}`);
    assert(fs.existsSync(runPath), `orchestrator run record missing: ${runPath}`);
    assert(fs.existsSync(path.join(workspace, '.AgentCowork', 'runs', `${runId}.events.jsonl`)), 'orchestrator event JSONL missing');

    const detail = await fetchJson(`${baseUrl}${detailUrl}`);
    assert(detail.status === 200, `${detailUrl} returned ${detail.status}: ${JSON.stringify(detail.body)}`);
    const run = record(detail.body.run, 'detail.run');
    const tasks = array(detail.body.tasks, 'detail.tasks');
    const results = array(detail.body.results, 'detail.results');
    const timeline = array(detail.body.timeline, 'detail.timeline').map((item) => record(item, 'timeline item'));
    assert(run.status === 'completed', 'detail run is not completed');
    assert(run.recipeId === 'weekly-report', 'detail run recipe changed');
    assert(tasks.length === 4, `expected 4 orchestrator tasks, got ${tasks.length}`);
    assert(results.length === 4, `expected 4 orchestrator results, got ${results.length}`);
    assert(timeline.some((event) => event.type === 'run_completed'), 'timeline missing run_completed event');
    assert(timeline.some((event) => event.type === 'budget_updated'), 'timeline missing budget_updated event');

    const evidenceDir = path.join(repoRoot, 'output', 'smoke');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'orchestrator-weekly-report.json');
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ok: true,
        workspace,
        runId,
        runPath,
        eventsPath: path.join(workspace, '.AgentCowork', 'runs', `${runId}.events.jsonl`),
        tasks: tasks.length,
        results: results.length,
        timelineEvents: timeline.length,
      }, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify({ ok: true, runId, evidencePath, tasks: tasks.length, results: results.length }, null, 2));
  } finally {
    await server.shutdown({ timeoutMs: 1000 });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
