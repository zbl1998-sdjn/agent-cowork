import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const runtimeFile = path.resolve(process.env.MVP_RUNTIME_FILE || path.join(buildDir, 'mvp-runtime.json'));
const reportPath = path.join(buildDir, 'mvp-demo-report.json');
const serverLogPath = path.join(buildDir, 'mvp-demo-server.log');
const nodeBin = process.execPath;
const runHostNodeScript = path.join(repoRoot, 'scripts', 'run-host-node.mjs');

type JsonRecord = Record<string, unknown>;
type RuntimeInfo = {
  pid?: unknown;
  host?: unknown;
  port?: unknown;
  url?: unknown;
};
type HealthResult = {
  statusCode?: number;
  body?: unknown;
  error?: string;
};
type RuntimeStatus = {
  ok: boolean;
  runtimeFile: string;
  runtimeExists: boolean;
  runtimeError: string | null;
  pidAlive: boolean;
  healthUrl: string | null;
  health: HealthResult | null;
  runtime: RuntimeInfo | null;
};
type StepResult = {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  durationMs: number;
  stdoutTail: string[];
  stderrTail: string[];
  error: string | undefined;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  return isRecord(value);
}

function runtimeUrl(runtime: RuntimeInfo | null, fallback: string | null): string {
  return typeof runtime?.url === 'string' ? runtime.url : fallback || '<unknown>';
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getHealth(url: string): Promise<HealthResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return { statusCode: response.status, body };
  } catch (error: unknown) {
    return { error: errorDetails(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function getRuntimeStatus(): Promise<RuntimeStatus> {
  let runtime: RuntimeInfo | null = null;
  let runtimeError: string | null = null;
  if (fs.existsSync(runtimeFile)) {
    try {
      const payload = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) as unknown;
      runtime = isRuntimeInfo(payload) ? payload : null;
      if (!runtime) {
        runtimeError = 'runtime file did not contain a JSON object';
      }
    } catch (error: unknown) {
      runtimeError = errorDetails(error);
    }
  }

  const pidAlive = runtime ? isPidAlive(runtime.pid) : false;
  let healthUrl: string | null = null;
  if (runtime && typeof runtime.host === 'string' && (typeof runtime.port === 'number' || typeof runtime.port === 'string')) {
    healthUrl = `http://${runtime.host}:${runtime.port}/health`;
  }
  const health = healthUrl ? await getHealth(healthUrl) : null;
  const healthBody = isRecord(health?.body) ? health.body : null;
  const healthOk = health?.statusCode === 200 && healthBody?.ok === true && healthBody?.service === 'agent-cowork-host';
  return {
    ok: Boolean(runtime && pidAlive && healthOk),
    runtimeFile,
    runtimeExists: fs.existsSync(runtimeFile),
    runtimeError,
    pidAlive,
    healthUrl,
    health,
    runtime,
  };
}

async function waitForRuntime(timeoutMs = 10000): Promise<RuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = await getRuntimeStatus();
  while (!lastStatus.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    lastStatus = await getRuntimeStatus();
  }
  return lastStatus;
}

function startMvpServer(): { pid?: number; logPath: string } {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.appendFileSync(serverLogPath, `\n--- demo:mvp start ${new Date().toISOString()} ---\n`, 'utf8');
  const logFd = fs.openSync(serverLogPath, 'a');
  const child = spawn(nodeBin, [runHostNodeScript, path.join(repoRoot, 'scripts', 'start-mvp.ts')], {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  child.unref();
  return typeof child.pid === 'number'
    ? { pid: child.pid, logPath: serverLogPath }
    : { logPath: serverLogPath };
}

function runStep(name: string, command: string, commandArgs: string[]): StepResult {
  console.log(`\n== ${name} ==`);
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  return {
    name,
    command: [command, ...commandArgs].join(' '),
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    stdoutTail: stdout.split(/\r?\n/).filter(Boolean).slice(-20),
    stderrTail: stderr.split(/\r?\n/).filter(Boolean).slice(-20),
    error: result.error?.message,
  };
}

function readJsonIfExists(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error: unknown) {
    return { ok: false, parseError: errorDetails(error) };
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(buildDir, { recursive: true });
  const initialStatus = await getRuntimeStatus();
  let serverStart: { pid?: number; logPath: string } | null = null;

  if (!initialStatus.ok) {
    console.log('No healthy MVP runtime was found; starting npm run start:mvp equivalent in the background.');
    serverStart = startMvpServer();
  } else {
    console.log(`Reusing running MVP: ${runtimeUrl(initialStatus.runtime, initialStatus.healthUrl)}`);
  }

  const readyStatus = await waitForRuntime();
  if (!readyStatus.ok) {
    throw new Error(`MVP runtime did not become healthy. Check ${serverLogPath}`);
  }
  console.log(`MVP ready: ${runtimeUrl(readyStatus.runtime, readyStatus.healthUrl)}`);

  const steps = [
    runStep('live MVP operation smoke', nodeBin, [path.join(repoRoot, 'scripts', 'smoke-live-mvp.mjs')]),
    runStep('default MVP verification', nodeBin, [path.join(repoRoot, 'scripts', 'verify-mvp.mjs')]),
  ];

  if (process.platform === 'win32') {
    steps.push(
      runStep('Windows client readiness', 'pwsh', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(repoRoot, 'scripts', 'check-windows-client-readiness.ps1'),
      ]),
    );
  }

  steps.push(runStep('MVP acceptance audit', nodeBin, [path.join(repoRoot, 'scripts', 'audit-mvp.mjs')]));

  const finalStatus = await waitForRuntime(3000);
  const audit = readJsonIfExists(path.join(buildDir, 'mvp-acceptance-audit.json'));
  const auditRecord = isRecord(audit) ? audit : null;
  const report = {
    ok: steps.every((step) => step.ok) && auditRecord?.ok === true && finalStatus.ok,
    completeGoal: auditRecord?.completeGoal === true,
    generatedAt: new Date().toISOString(),
    serverStart,
    initialStatus,
    finalStatus,
    steps,
    reports: {
      verification: path.join(buildDir, 'mvp-verification-report.json'),
      liveMvpSmoke: path.join(buildDir, 'live-mvp-smoke-report.json'),
      acceptanceAudit: path.join(buildDir, 'mvp-acceptance-audit.json'),
      windowsReadiness: path.join(buildDir, 'windows-client-readiness.json'),
      demo: reportPath,
    },
    summary: auditRecord?.summary,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('\n== demo:mvp report ==');
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const report = {
    ok: false,
    completeGoal: false,
    generatedAt: new Date().toISOString(),
    error: errorDetails(error),
  };
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(errorDetails(error));
  process.exit(1);
});
