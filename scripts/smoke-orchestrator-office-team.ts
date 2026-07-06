// Orchestrator office-team 冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:在临时受信工作区拉起真实 Host HTTP 服务,通过 /api/orchestrator/run
//       启动 office-team recipe,确认它走 subagent adapter 并可回读 detail。
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { HostServer } from '../apps/host/src/server.js';

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-orchestrator-office-'));
  const sourcePath = path.join(workspace, 'office.md');
  fs.writeFileSync(
    sourcePath,
    [
      '# Office handoff',
      '- Need a concise Word-style brief for the rollout.',
      '- Need a deck outline with evidence-first status.',
      '- Need a file organization preview, no writes.',
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
    const start = await fetchJson(`${baseUrl}/api/orchestrator/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `smoke-orchestrator-office-${Date.now()}`,
      },
      body: JSON.stringify({
        workspaceRoot: workspace,
        userGoal: 'Prepare an office handoff from the supplied note.',
        recipeId: 'office-team',
        refs: [{
          refId: 'office-note',
          kind: 'file',
          label: 'office.md',
          dataTags: ['internal'],
          text: fs.readFileSync(sourcePath, 'utf8'),
          summary: 'Office handoff source note.',
          uri: `file://${sourcePath}`,
        }],
      }),
    });

    assert(start.status === 200, `/api/orchestrator/run returned ${start.status}: ${JSON.stringify(start.body)}`);
    assert(start.body.status === 'completed', 'office-team orchestrator run did not complete');
    assert(start.body.selectedRecipeId === 'office-team', 'office-team smoke selected the wrong recipe');
    assert(start.body.runnerKind === 'subagent', 'office-team smoke did not use the subagent runner');
    const runId = String(start.body.runId || '');
    const detailUrl = String(start.body.detailUrl || '');
    const runPath = String(start.body.runPath || '');
    assert(/^run_/.test(runId), `unexpected run id: ${runId}`);
    assert(fs.existsSync(runPath), `orchestrator run record missing: ${runPath}`);

    const detail = await fetchJson(`${baseUrl}${detailUrl}`);
    assert(detail.status === 200, `${detailUrl} returned ${detail.status}: ${JSON.stringify(detail.body)}`);
    const tasks = array(detail.body.tasks, 'detail.tasks');
    const results = array(detail.body.results, 'detail.results').map((item) => record(item, 'result'));
    const timeline = array(detail.body.timeline, 'detail.timeline').map((item) => record(item, 'timeline item'));
    assert(tasks.length === 6, `expected 6 office-team tasks, got ${tasks.length}`);
    assert(results.length === 6, `expected 6 office-team results, got ${results.length}`);
    assert(results.some((result) => record(result.structured, 'result.structured').subagentRunId), 'results missing subagent run evidence');
    const handoffs = timeline.filter((event) => event.type === 'handoff_started');
    assert(handoffs.length === 6, `expected 6 handoff events, got ${handoffs.length}`);
    const firstHandoff = record(handoffs[0], 'first handoff');
    assert(firstHandoff.toAgentId === 'excel_helper', 'first handoff should target excel_helper');
    assert(array(firstHandoff.contextRefIds, 'firstHandoff.contextRefIds').includes('office-note'), 'first handoff missing source ref');
    assert(Number(record(firstHandoff.budget, 'firstHandoff.budget').maxRuntimeMs) > 0, 'first handoff missing budget');
    assert(timeline.some((event) => event.type === 'run_completed'), 'timeline missing run_completed event');

    const evidenceDir = path.join(repoRoot, 'output', 'smoke');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'orchestrator-office-team.json');
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify({ ok: true, workspace, runId, runPath, tasks: tasks.length, results: results.length, handoffs: handoffs.length, firstHandoffReason: firstHandoff.reason }, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify({ ok: true, runId, evidencePath, tasks: tasks.length, results: results.length, handoffs: handoffs.length }, null, 2));
  } finally {
    await server.shutdown({ timeoutMs: 1000 });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
