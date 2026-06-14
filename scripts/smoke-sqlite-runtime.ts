// SQLite 后端持久化冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:以 storeBackend:'sqlite' 拉起 Host,确认 node:sqlite 可用后写入一批状态——
//       游客鉴权 token、记忆事实、recipe 运行、定时计划;关闭服务后用同一 db 文件重启,
//       断言 auth/memory/runs-index/schedules 全部跨重启持久化,以此验证 SQLite 后端的
//       落盘与恢复。报告写 build/(或设 SQLITE_RUNTIME_ARCHIVE=1 归档到 reports/sqlite-runtime)。
// 用法:npm run smoke:sqlite-runtime(即 node scripts/run-host-node.mjs scripts/smoke-sqlite-runtime.ts);
//       失败置 exitCode=1 阻断。
// 依赖:apps/host 的 createServer;需运行时内置 node:sqlite(缺失即抛错)。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { AddressInfo } from 'node:http';
import type { HostServer } from '../apps/host/src/server.js';

const require = createRequire(import.meta.url);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const defaultReportPath = path.join(buildDir, 'sqlite-runtime-smoke-report.json');
const archiveRequested = process.env.SQLITE_RUNTIME_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.SQLITE_RUNTIME_REPORT_DIR || path.join(repoRoot, 'reports', 'sqlite-runtime'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `sqlite-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;

type JsonRecord = Record<string, unknown>;
type JsonResponse = {
  status: number;
  body: unknown;
};
type RequestJsonOptions = {
  method?: string;
  token?: string;
  idempotencyKey?: string;
  body?: unknown;
};
type ProcessWithExitCode = typeof process & {
  exitCode?: number;
};
type RuntimeDependency = {
  id?: unknown;
  status?: unknown;
  version?: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stackOrMessage(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value != null;
}

function asRecord(value: unknown, label: string): JsonRecord {
  assert(isRecord(value), `${label} was not an object: ${JSON.stringify(value)}`);
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === 'string' && value.length > 0, `${label} missing`);
  return value;
}

function readRecordArray(value: unknown, label: string): JsonRecord[] {
  assert(Array.isArray(value), `${label} was not an array`);
  return value.map((item, index) => asRecord(item, `${label}[${index}]`));
}

function assertInside(child: string, parent: string, label: string): void {
  const relative = path.relative(parent, child);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escaped expected parent: ${child}`);
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addressInfo = server.address();
  assert(addressInfo && typeof addressInfo === 'object', 'sqlite smoke server did not bind to a TCP address');
  const { address, port } = addressInfo as AddressInfo;
  return `http://${address}:${port}`;
}

async function requestJson(
  baseUrl: string,
  route: string,
  { method = 'GET', token = '', idempotencyKey = '', body }: RequestJsonOptions = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const request: RequestInit = {
    method,
    headers,
  };
  if (body != null) {
    request.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${route}`, request);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return { status: response.status, body: payload };
}

function createSqliteHost({ workspace, dbPath, authDbPath }: { workspace: string; dbPath: string; authDbPath: string }): HostServer {
  return createServer({
    trustedRoot: workspace,
    storeBackend: 'sqlite',
    sqliteDbPath: dbPath,
    authDbPath,
    enableScheduler: true,
    startScheduler: false,
    rateLimit: false,
  });
}

async function closeHost(server: HostServer): Promise<void> {
  await server.shutdown({ timeoutMs: 3000 });
}

function findSqliteDependency(dependencies: JsonRecord[]): RuntimeDependency | undefined {
  return dependencies.find((item) => item.id === 'sqlite');
}

function getProcessVersions(): Record<string, string | undefined> {
  return process.versions || {};
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  try {
    require('node:sqlite');
  } catch (err) {
    throw new Error(`node:sqlite is not available in this runtime: ${formatError(err)}`);
  }

  const workspace = path.join(buildDir, 'sqlite-runtime-smoke-workspace');
  assertInside(workspace, buildDir, 'sqlite smoke workspace');
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, '.AgentCowork'), { recursive: true });

  const dbPath = path.join(workspace, '.AgentCowork', 'state.sqlite');
  const authDbPath = path.join(workspace, '.AgentCowork', 'auth.sqlite');

  let server = createSqliteHost({ workspace, dbPath, authDbPath });
  let baseUrl = await bind(server);
  let token = '';
  let createdScheduleId = '';
  let createdRunId = '';

  try {
    const guest = await requestJson(baseUrl, '/api/auth/guest', { method: 'POST', body: {} });
    const guestBody = asRecord(guest.body, 'guest auth body');
    assert(guest.status === 200, `guest auth failed: ${JSON.stringify(guestBody)}`);
    token = readString(guestBody.token, 'guest token');

    const runtime = await requestJson(baseUrl, '/api/runtime/dependencies', { token });
    assert(runtime.status === 200, `runtime dependencies failed: ${JSON.stringify(runtime.body)}`);
    const runtimeBody = asRecord(runtime.body, 'runtime dependencies body');
    const sqliteDep = findSqliteDependency(readRecordArray(runtimeBody.dependencies, 'runtime dependencies'));
    assert(sqliteDep?.status === 'available' && sqliteDep.version, `sqlite dependency unavailable: ${JSON.stringify(sqliteDep)}`);

    const fact = await requestJson(baseUrl, '/api/memory/facts', {
      method: 'POST',
      token,
      body: { key: 'SQLite smoke', value: 'state persisted through restart' },
    });
    assert(fact.status === 200, `memory fact failed: ${JSON.stringify(fact.body)}`);

    // 持久化 smoke 用不需来源的配方(folder-organize):meeting-actions 等转换型配方要求来源材料,空 files 会被 422 熔断。
    const run = await requestJson(baseUrl, '/api/recipes/folder-organize/run', {
      method: 'POST',
      token,
      idempotencyKey: 'sqlite-runtime-run',
      body: { prompt: 'SQLite smoke run', files: [] },
    });
    const runBody = asRecord(run.body, 'recipe run body');
    assert(run.status === 200, `recipe run failed: ${JSON.stringify(runBody)}`);
    createdRunId = readString(runBody.runId, 'recipe run id');

    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const schedule = await requestJson(baseUrl, '/api/schedules', {
      method: 'POST',
      token,
      idempotencyKey: 'sqlite-runtime-schedule',
      body: { name: 'sqlite-smoke', fireAt, payload: { recipeId: 'meeting-actions' } },
    });
    const scheduleBody = asRecord(schedule.body, 'schedule create body');
    const scheduleRecord = asRecord(scheduleBody.schedule, 'created schedule');
    assert(schedule.status === 200, `schedule create failed: ${JSON.stringify(scheduleBody)}`);
    createdScheduleId = readString(scheduleRecord.id, 'created schedule id');
  } finally {
    await closeHost(server);
  }

  assert(fs.existsSync(dbPath), 'state.sqlite was not created');
  assert(fs.existsSync(authDbPath), 'auth.sqlite was not created');

  server = createSqliteHost({ workspace, dbPath, authDbPath });
  baseUrl = await bind(server);

  try {
    const me = await requestJson(baseUrl, '/api/auth/me', { token });
    assert(me.status === 200, `persisted auth token failed after restart: ${JSON.stringify(me.body)}`);

    const memory = await requestJson(baseUrl, '/api/memory', { token });
    assert(memory.status === 200, `memory read failed after restart: ${JSON.stringify(memory.body)}`);
    const memoryBody = asRecord(memory.body, 'memory body');
    const memoryRecord = asRecord(memoryBody.memory, 'memory payload');
    assert(String(memoryRecord.text || '').includes('SQLite smoke'), 'sqlite memory did not persist through restart');

    const runs = await requestJson(baseUrl, '/api/runs/index', { token });
    assert(runs.status === 200, `runs index failed after restart: ${JSON.stringify(runs.body)}`);
    const runsBody = asRecord(runs.body, 'runs index body');
    assert(readRecordArray(runsBody.runs, 'runs index').some((item) => item.id === createdRunId), 'sqlite runs index did not persist recipe run');

    const schedules = await requestJson(baseUrl, '/api/schedules', { token });
    assert(schedules.status === 200, `schedule list failed after restart: ${JSON.stringify(schedules.body)}`);
    const schedulesBody = asRecord(schedules.body, 'schedules body');
    assert(readRecordArray(schedulesBody.schedules, 'schedules').some((item) => item.id === createdScheduleId), 'sqlite schedule did not persist through restart');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      sqliteVersion: getProcessVersions().sqlite,
      workspace,
      dbPath,
      authDbPath,
      reportPath,
      persisted: {
        auth: true,
        memory: true,
        runId: createdRunId,
        scheduleId: createdScheduleId,
      },
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      sqliteVersion: getProcessVersions().sqlite,
      workspace,
      dbPath,
      authDbPath,
      reportPath,
      error: stackOrMessage(error),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(stackOrMessage(error));
    (process as ProcessWithExitCode).exitCode = 1;
  } finally {
    await closeHost(server);
  }
}

main().catch((error) => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    reportPath,
    error: stackOrMessage(error),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(stackOrMessage(error));
  process.exit(1);
});
