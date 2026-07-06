// P1 Orchestrator file-summary-cache smoke (scripts · smoke · E2E)
// ---------------------------------------------------------------------------
// Starts the real Host HTTP server, runs the same weekly-report file twice with
// different request idempotency keys, and verifies the second run hits the
// tenant-scoped file summary cache.
// Usage: node scripts/run-host-node.mjs scripts/smoke-orchestrator-summary-cache.ts
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
  assert(address && typeof address === 'object', 'orchestrator summary cache smoke server did not bind');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: JsonRecord }> {
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : {};
  return { status: response.status, body: record(parsed, url) };
}

function requestBody(workspace: string, notePath: string, summary: string): JsonRecord {
  return {
    workspaceRoot: workspace,
    userGoal: 'Create a weekly report and reuse cached file summaries.',
    recipeId: 'weekly-report',
    refs: [{
      refId: 'cache-note',
      kind: 'file',
      label: 'cache-note.md',
      dataTags: ['internal'],
      text: fs.readFileSync(notePath, 'utf8'),
      summary,
      uri: `file://${notePath}`,
    }],
  };
}

async function startRun(baseUrl: string, body: JsonRecord, idempotencyKey: string): Promise<JsonRecord> {
  const response = await fetchJson(`${baseUrl}/api/orchestrator/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  assert(response.status === 200, `/api/orchestrator/run returned ${response.status}: ${JSON.stringify(response.body)}`);
  assert(response.body.status === 'completed', 'orchestrator run did not complete');
  return response.body;
}

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(scriptDir);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-orchestrator-cache-'));
  const notePath = path.join(workspace, 'cache-note.md');
  fs.writeFileSync(notePath, 'Stable source text for route-level summary cache smoke.\n', 'utf8');

  const server = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    connectMcpOnStart: false,
    enableScheduler: false,
  });
  const baseUrl = await listenLocal(server);

  try {
    await startRun(baseUrl, requestBody(workspace, notePath, 'First smoke cached summary.'), `summary-cache-a-${Date.now()}`);
    const second = await startRun(
      baseUrl,
      requestBody(workspace, notePath, 'Second supplied summary should be replaced by cache.'),
      `summary-cache-b-${Date.now()}`,
    );
    const events = array(second.events, 'second.events').map((event) => record(event, 'event'));
    const cacheEvents = events.filter((event) => event.type === 'summary_cache_updated');
    assert(cacheEvents.some((event) => Number(event.hits) > 0), 'second run did not record a file summary cache hit');

    const runId = String(second.runId || '');
    const detailUrl = String(second.detailUrl || '');
    assert(/^run_/.test(runId), `unexpected second run id: ${runId}`);
    const detail = await fetchJson(`${baseUrl}${detailUrl}`);
    assert(detail.status === 200, `${detailUrl} returned ${detail.status}: ${JSON.stringify(detail.body)}`);
    const tasks = array(detail.body.tasks, 'detail.tasks').map((task) => record(task, 'task'));
    const writerTask = tasks.find((task) => task.agentId === 'writer');
    assert(writerTask, 'writer task missing from second run detail');
    const writerRef = record(array(writerTask.inputRefs, 'writer.inputRefs')[0], 'writer.inputRef');
    assert(writerRef.summary === 'First smoke cached summary.', 'writer did not reuse the cached summary from the first run');
    const summaryCache = record(record(writerRef.metadata, 'writerRef.metadata').summaryCache, 'writerRef.summaryCache');
    assert(summaryCache.hit === true, 'writer input ref did not mark cache hit');

    const evidenceDir = path.join(repoRoot, 'output', 'smoke');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'orchestrator-summary-cache.json');
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ok: true,
        workspace,
        runId,
        detailUrl,
        cacheEvents: cacheEvents.length,
        cacheHits: cacheEvents.reduce((sum, event) => sum + Number(event.hits || 0), 0),
        writerSummary: writerRef.summary,
      }, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify({ ok: true, runId, evidencePath, cacheEvents: cacheEvents.length }, null, 2));
  } finally {
    await server.shutdown({ timeoutMs: 1000 });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});