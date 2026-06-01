import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:http';
import type { ChildProcessLike, SpawnSyncResult } from 'node:child_process';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const reportPath = path.join(buildDir, 'mvp-runtime-smoke-report.json');
const nodeBin = process.execPath;
const runHostNodeScript = path.join(repoRoot, 'scripts', 'run-host-node.mjs');

type RuntimeFile = {
  pid?: unknown;
  port?: unknown;
  workspace?: unknown;
};
type RuntimeStatus = {
  ok?: unknown;
  pidAlive?: unknown;
};
type RuntimeStop = {
  ok?: unknown;
  stopped?: unknown;
};
type HealthPayload = {
  ok?: unknown;
  service?: unknown;
};
type KillableProcess = typeof process & {
  kill(pid: number, signal?: string | number): void;
  exitCode?: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function setExitCode(code: number): void {
  (process as KillableProcess).exitCode = code;
}

function isPidAlive(pid: unknown): boolean {
  const pidNumber = Number(pid);
  if (!Number.isInteger(pidNumber) || pidNumber <= 0 || pidNumber === process.pid) {
    return false;
  }
  try {
    (process as KillableProcess).kill(pidNumber, 0);
    return true;
  } catch {
    return false;
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object', 'free-port probe did not bind to a TCP port');
      const { port } = address as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getHealth(url: string, timeoutMs = 8000): Promise<HealthPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const body = await response.text();
        if (response.status !== 200) {
          throw new Error(`${url} returned ${response.status}: ${body}`);
        }
        return JSON.parse(body) as HealthPayload;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function runNodeScript(script: string, env: Record<string, string | undefined>): SpawnSyncResult {
  return spawnSync(nodeBin, [runHostNodeScript, path.join(repoRoot, 'scripts', script)], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}`);
  }
}

function spawnOutput(result: SpawnSyncResult): string {
  return String(result.stderr || result.stdout || '');
}

async function waitForExit(child: ChildProcessLike, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    child.on('close', () => resolve(true));
    setTimeout(() => resolve(false), timeoutMs);
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(buildDir, { recursive: true });
  const port = await getFreePort();
  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-runtime-workspace-'));
  const runtimeFile = path.join(buildDir, `kcw-runtime-${process.pid}-${Date.now()}.json`);
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    TRUSTED_ROOT: workspace,
    MVP_RUNTIME_FILE: runtimeFile,
    NO_OPEN: '1',
  };

  const child = spawn(nodeBin, [runHostNodeScript, path.join(repoRoot, 'scripts', 'start-mvp.ts')], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    const health = await getHealth(`http://127.0.0.1:${port}/health`);
    assert(health.ok === true && health.service === 'agent-cowork-host', 'runtime health check failed');
    assert(fs.existsSync(runtimeFile), 'runtime file was not written by start:mvp');
    const runtime = parseJson<RuntimeFile>(fs.readFileSync(runtimeFile, 'utf8'), 'runtime file');
    assert(isPidAlive(runtime.pid), 'runtime pid is not alive');
    assert(runtime.port === port, 'runtime port mismatch');
    assert(runtime.workspace === workspace, 'runtime workspace mismatch');

    const statusBefore = runNodeScript('status-mvp.ts', env);
    assert(statusBefore.status === 0, `status:mvp failed before stop: ${spawnOutput(statusBefore)}`);
    const statusPayload = parseJson<RuntimeStatus>(String(statusBefore.stdout), 'status:mvp');
    assert(statusPayload.ok === true && statusPayload.pidAlive === true, 'status:mvp did not report a live runtime');

    const stop = runNodeScript('stop-mvp.ts', env);
    assert(stop.status === 0, `stop:mvp failed: ${spawnOutput(stop)}`);
    const stopPayload = parseJson<RuntimeStop>(String(stop.stdout), 'stop:mvp');
    assert(stopPayload.ok === true && stopPayload.stopped === true, 'stop:mvp did not stop the runtime');

    const stopped = await waitForExit(child, 5000);
    assert(stopped, 'start:mvp child did not exit after stop:mvp');
    assert(!fs.existsSync(runtimeFile), 'runtime file still exists after stop');

    const statusAfter = runNodeScript('status-mvp.ts', env);
    assert(statusAfter.status !== 0, 'status:mvp unexpectedly reported running after stop');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      port,
      workspace,
      runtimeFile,
      runtime,
      health,
      statusBefore: statusPayload,
      stop: stopPayload,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    child.kill('SIGTERM');
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      port,
      workspace,
      runtimeFile,
      error: error instanceof Error ? error.stack || error.message : String(error),
      stdout: stdout.join('').split(/\r?\n/).slice(-40),
      stderr: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    setExitCode(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
