// Orchestrator checkpoint/resume 冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:在临时受信工作区写入非终态 orchestrator checkpoint,拉起真实 Host HTTP 服务,
//       通过 /api/orchestrator/runs/:runId/resume 续跑并回读 detail/checkpoint。
// 用法:node scripts/run-host-node.mjs scripts/smoke-orchestrator-resume.ts
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrationCheckpointStore } from '../apps/host/src/orchestrator/index.js';
import { createServer } from '../apps/host/src/server.js';
import type { HostServer } from '../apps/host/src/server.js';

const RUN_ID = 'run_orchestrator_resume_smoke';

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
  assert(address && typeof address === 'object', 'orchestrator resume smoke server did not bind to a TCP port');
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-orchestrator-resume-smoke-'));
  const runStoreRoot = path.join(workspace, '.AgentCowork', 'runs');
  const sourcePath = path.join(workspace, 'resume-weekly.md');
  const secretLikeSource = ['api', '_key=', 'sk-', 'resumesmokeshouldredact123456'].join('');
  const secretLikeMetadata = ['api', '_key=', 'sk-', 'resumesmokemetadata123456'].join('');
  fs.writeFileSync(
    sourcePath,
    [
      '# Resume smoke source',
      '- Checkpoint should resume through the HTTP route.',
      `- The checkpoint includes ${secretLikeSource} for redaction proof.`,
    ].join('\n'),
    'utf8',
  );

  const checkpointStore = createOrchestrationCheckpointStore({ root: runStoreRoot });
  const initialCheckpointPath = checkpointStore.save({
    version: 1,
    runId: RUN_ID,
    userGoal: 'Resume a weekly report orchestration from checkpoint.',
    recipeId: 'weekly-report',
    mode: 'workflow',
    status: 'running',
    workspaceRoot: workspace,
    securityMode: 'local_strict',
    agents: ['researcher', 'writer', 'verifier', 'security_reviewer'],
    refs: [{
      refId: 'resume-source',
      kind: 'file',
      label: 'resume-weekly.md',
      dataTags: ['internal'],
      text: fs.readFileSync(sourcePath, 'utf8'),
      summary: 'Resume smoke source note.',
      uri: `file://${sourcePath}`,
      metadata: { note: secretLikeMetadata },
    }],
    tasks: [],
    results: [],
    completedStepIds: [],
    currentStepId: 'research',
    eventsPath: path.join(runStoreRoot, `${RUN_ID}.events.jsonl`),
    checkpointPath: '',
    artifacts: [],
    startedAt: new Date('2026-07-05T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-07-05T00:00:00.000Z').toISOString(),
  });
  assert(fs.existsSync(initialCheckpointPath), 'initial checkpoint should be written');
  assert(!fs.readFileSync(initialCheckpointPath, 'utf8').includes('sk-resumesmoke'), 'initial checkpoint should be redacted');

  const server = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    connectMcpOnStart: false,
    enableScheduler: false,
  });
  const baseUrl = await listenLocal(server);

  try {
    const resume = await fetchJson(`${baseUrl}/api/orchestrator/runs/${RUN_ID}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `smoke-orchestrator-resume-${Date.now()}`,
      },
      body: JSON.stringify({}),
    });
    assert(resume.status === 200, `/resume returned ${resume.status}: ${JSON.stringify(resume.body)}`);
    assert(resume.body.resumed === true, 'resume response should mark resumed=true');
    assert(resume.body.status === 'completed', 'resumed orchestrator run did not complete');
    assert(resume.body.runId === RUN_ID, 'resumed run id changed');
    const detailUrl = String(resume.body.detailUrl || '');
    const checkpointUrl = String(resume.body.checkpointUrl || '');
    const runPath = String(resume.body.runPath || '');
    const checkpointPath = String(resume.body.checkpointPath || '');
    assert(detailUrl === `/api/orchestrator/runs/${RUN_ID}`, `unexpected detail url: ${detailUrl}`);
    assert(checkpointUrl === `/api/orchestrator/runs/${RUN_ID}/checkpoint`, `unexpected checkpoint url: ${checkpointUrl}`);
    assert(fs.existsSync(runPath), `resumed run record missing: ${runPath}`);
    assert(fs.existsSync(checkpointPath), `resumed checkpoint missing: ${checkpointPath}`);
    assert(!fs.readFileSync(checkpointPath, 'utf8').includes('sk-resumesmoke'), 'resumed checkpoint should remain redacted');

    const detail = await fetchJson(`${baseUrl}${detailUrl}`);
    assert(detail.status === 200, `${detailUrl} returned ${detail.status}: ${JSON.stringify(detail.body)}`);
    const tasks = array(detail.body.tasks, 'detail.tasks');
    const results = array(detail.body.results, 'detail.results');
    assert(tasks.length === 4, `expected 4 resumed tasks, got ${tasks.length}`);
    assert(results.length === 4, `expected 4 resumed results, got ${results.length}`);

    const checkpoint = await fetchJson(`${baseUrl}${checkpointUrl}`);
    assert(checkpoint.status === 200, `${checkpointUrl} returned ${checkpoint.status}: ${JSON.stringify(checkpoint.body)}`);
    const checkpointBody = record(checkpoint.body.checkpoint, 'checkpoint.body.checkpoint');
    assert(checkpointBody.status === 'completed', 'checkpoint was not updated to completed');
    assert(array(checkpointBody.completedStepIds, 'checkpoint.completedStepIds').length === 6, 'checkpoint should record all workflow steps');

    const evidenceDir = path.join(repoRoot, 'output', 'smoke');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'orchestrator-resume.json');
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ok: true,
        workspace,
        runId: RUN_ID,
        runPath,
        checkpointPath,
        eventsPath: path.join(runStoreRoot, `${RUN_ID}.events.jsonl`),
        tasks: tasks.length,
        results: results.length,
        completedStepIds: array(checkpointBody.completedStepIds, 'checkpoint.completedStepIds').length,
      }, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify({ ok: true, runId: RUN_ID, evidencePath, tasks: tasks.length, results: results.length }, null, 2));
  } finally {
    await server.shutdown({ timeoutMs: 1000 });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});