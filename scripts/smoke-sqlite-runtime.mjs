import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';

const require = createRequire(import.meta.url);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const defaultReportPath = path.join(buildDir, 'sqlite-runtime-smoke-report.json');
const archiveRequested = process.env.SQLITE_RUNTIME_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.SQLITE_RUNTIME_REPORT_DIR || path.join(repoRoot, 'reports', 'sqlite-runtime'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `sqlite-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertInside(child, parent, label) {
  const relative = path.relative(parent, child);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escaped expected parent: ${child}`);
}

async function bind(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { address, port } = server.address();
  return `http://${address}:${port}`;
}

async function requestJson(baseUrl, route, { method = 'GET', token = '', idempotencyKey = '', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return { status: response.status, body: payload };
}

function createSqliteHost({ workspace, dbPath, authDbPath }) {
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

async function closeHost(server) {
  if (typeof server.shutdown === 'function') {
    await server.shutdown({ timeoutMs: 3000 });
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  try {
    require('node:sqlite');
  } catch (err) {
    throw new Error(`node:sqlite is not available in this runtime: ${err.message}`);
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
    assert(guest.status === 200 && guest.body.token, `guest auth failed: ${JSON.stringify(guest.body)}`);
    token = guest.body.token;

    const runtime = await requestJson(baseUrl, '/api/runtime/dependencies', { token });
    assert(runtime.status === 200, `runtime dependencies failed: ${JSON.stringify(runtime.body)}`);
    const sqliteDep = runtime.body.dependencies.find((item) => item.id === 'sqlite');
    assert(sqliteDep?.status === 'available' && sqliteDep.version, `sqlite dependency unavailable: ${JSON.stringify(sqliteDep)}`);

    const fact = await requestJson(baseUrl, '/api/memory/facts', {
      method: 'POST',
      token,
      body: { key: 'SQLite smoke', value: 'state persisted through restart' },
    });
    assert(fact.status === 200, `memory fact failed: ${JSON.stringify(fact.body)}`);

    const run = await requestJson(baseUrl, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      token,
      idempotencyKey: 'sqlite-runtime-run',
      body: { prompt: 'SQLite smoke run', files: [] },
    });
    assert(run.status === 200 && run.body.runId, `recipe run failed: ${JSON.stringify(run.body)}`);
    createdRunId = run.body.runId;

    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const schedule = await requestJson(baseUrl, '/api/schedules', {
      method: 'POST',
      token,
      idempotencyKey: 'sqlite-runtime-schedule',
      body: { name: 'sqlite-smoke', fireAt, payload: { recipeId: 'meeting-actions' } },
    });
    assert(schedule.status === 200 && schedule.body.schedule?.id, `schedule create failed: ${JSON.stringify(schedule.body)}`);
    createdScheduleId = schedule.body.schedule.id;
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
    assert(String(memory.body.memory?.text || '').includes('SQLite smoke'), 'sqlite memory did not persist through restart');

    const runs = await requestJson(baseUrl, '/api/runs/index', { token });
    assert(runs.status === 200, `runs index failed after restart: ${JSON.stringify(runs.body)}`);
    assert(runs.body.runs.some((item) => item.id === createdRunId), 'sqlite runs index did not persist recipe run');

    const schedules = await requestJson(baseUrl, '/api/schedules', { token });
    assert(schedules.status === 200, `schedule list failed after restart: ${JSON.stringify(schedules.body)}`);
    assert(schedules.body.schedules.some((item) => item.id === createdScheduleId), 'sqlite schedule did not persist through restart');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      sqliteVersion: process.versions.sqlite,
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
      sqliteVersion: process.versions.sqlite,
      workspace,
      dbPath,
      authDbPath,
      reportPath,
      error: error.stack || error.message,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(error.stack || error.message);
    process.exitCode = 1;
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
    error: error.stack || error.message,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error.stack || error.message);
  process.exit(1);
});
