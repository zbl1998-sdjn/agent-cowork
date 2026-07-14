// Orchestrator async/cancel 冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:拉起真实 Host HTTP 服务,用 fake local OpenAI-compatible provider 启动
//       /api/orchestrator/run-async,再通过 /cancel 中止并确认 run record/checkpoint 落 cancelled。
// 用法:node scripts/run-host-node.mjs scripts/smoke-orchestrator-async-cancel.ts
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { HostServer } from '../apps/host/src/server.js';

type JsonRecord = Record<string, unknown>;

type FetchInitLike = { signal?: AbortSignal };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, label: string): JsonRecord {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as JsonRecord;
}

async function listenLocal(server: HostServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'orchestrator async smoke server did not bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: JsonRecord }> {
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : {};
  return { status: response.status, body: record(parsed, url) };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(scriptDir);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-orchestrator-async-smoke-'));
  const notesPath = path.join(workspace, 'async-notes.md');
  fs.writeFileSync(notesPath, 'Async provider-backed orchestrator smoke source note.\n', 'utf8');

  let providerCalls = 0;
  let abortedBySignal = false;
  const fakeFetch = (async (_url: string, init?: FetchInitLike) => {
    providerCalls += 1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      init?.signal?.addEventListener('abort', () => {
        abortedBySignal = true;
        clearTimeout(timer);
        const error = new Error('fake provider aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    return {
      ok: true,
      status: 200,
      body: null,
      async json() {
        return { choices: [{ message: { content: 'late provider output' } }], usage: { total_tokens: 3 } };
      },
    };
  }) as unknown as typeof fetch;

  const server = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    connectMcpOnStart: false,
    enableScheduler: false,
    modelProvider: 'openai/local',
    modelBaseUrl: 'http://127.0.0.1:9/v1',
    model: 'local-smoke-model',
    oauthFetch: fakeFetch,
  });
  const baseUrl = await listenLocal(server);

  try {
    const start = await fetchJson(`${baseUrl}/api/orchestrator/run-async`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `smoke-orchestrator-async-${Date.now()}`,
      },
      body: JSON.stringify({
        workspaceRoot: workspace,
        userGoal: 'Create an async provider-backed report and then cancel it.',
        recipeId: 'weekly-report',
        refs: [{
          refId: 'async-note',
          kind: 'file',
          label: 'async-notes.md',
          dataTags: ['internal'],
          text: fs.readFileSync(notesPath, 'utf8'),
          summary: 'Async smoke source note.',
          uri: `file://${notesPath}`,
        }],
      }),
    });
    assert(start.status === 202, `/api/orchestrator/run-async returned ${start.status}: ${JSON.stringify(start.body)}`);
    assert(start.body.status === 'running', 'async orchestrator did not start as running');
    assert(start.body.runnerKind === 'provider', `expected provider runner, got ${String(start.body.runnerKind)}`);
    const runId = String(start.body.runId || '');
    assert(/^run_/.test(runId), `unexpected run id: ${runId}`);

    await waitFor(() => providerCalls > 0, 'provider call start');
    const cancel = await fetchJson(`${baseUrl}/api/orchestrator/runs/${runId}/cancel`, { method: 'POST' });
    assert(cancel.status === 200, `/cancel returned ${cancel.status}: ${JSON.stringify(cancel.body)}`);
    assert(cancel.body.cancelled === true, 'cancel endpoint did not report cancellation');

    let finalStatus = '';
    await waitFor(async () => {
      const detail = await fetchJson(`${baseUrl}/api/orchestrator/runs/${runId}`);
      assert(detail.status === 200, `detail returned ${detail.status}: ${JSON.stringify(detail.body)}`);
      const detailRun = record(detail.body.run, 'detail.run');
      finalStatus = String(detailRun.status || '');
      return finalStatus === 'cancelled';
    }, 'cancelled run record');
    assert(abortedBySignal, 'fake provider did not observe AbortSignal');

    const checkpoint = await fetchJson(`${baseUrl}/api/orchestrator/runs/${runId}/checkpoint`);
    assert(checkpoint.status === 200, `checkpoint returned ${checkpoint.status}: ${JSON.stringify(checkpoint.body)}`);
    assert(record(checkpoint.body.checkpoint, 'checkpoint').status === 'cancelled', 'checkpoint status is not cancelled');

    const evidenceDir = path.join(repoRoot, 'output', 'smoke');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'orchestrator-async-cancel.json');
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ok: true,
        workspace,
        runId,
        providerCalls,
        abortedBySignal,
        status: finalStatus,
        runPath: start.body.runPath,
        checkpointPath: start.body.checkpointPath,
      }, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify({ ok: true, runId, evidencePath, providerCalls, abortedBySignal }, null, 2));
  } finally {
    await server.shutdown({ timeoutMs: 1000 });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
