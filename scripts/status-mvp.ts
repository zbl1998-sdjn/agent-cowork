import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type RuntimeState = Record<string, unknown> & {
  host?: unknown;
  pid?: unknown;
  port?: unknown;
};

type HttpHealth = {
  statusCode: number | undefined;
  body: unknown;
};

type HealthResult = HttpHealth | {
  error: string;
};

type ProcessWithKill = typeof process & {
  kill(pid: number, signal?: string | number): void;
  exitCode?: number;
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeFile = path.resolve(process.env.MVP_RUNTIME_FILE || path.join(repoRoot, 'build', 'mvp-runtime.json'));
const processWithKill = process as ProcessWithKill;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

function parseRuntime(value: unknown): RuntimeState | null {
  return isObjectRecord(value) ? value : null;
}

function runtimeHealthUrl(runtime: RuntimeState | null): string | null {
  if (typeof runtime?.host !== 'string' || typeof runtime.port !== 'number') {
    return null;
  }
  return `http://${runtime.host}:${runtime.port}/health`;
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    processWithKill.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAgentHealth(body: unknown): boolean {
  return isObjectRecord(body) && body.ok === true && body.service === 'agent-cowork-host';
}

function isHttpHealth(health: HealthResult | null): health is HttpHealth {
  return health != null && 'statusCode' in health;
}

async function getHealth(url: string): Promise<HealthResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    try {
      return { statusCode: response.status, body: JSON.parse(text) };
    } catch {
      return { statusCode: response.status, body: text };
    }
  } catch (error) {
    return { error: formatError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  let runtime: RuntimeState | null = null;
  let runtimeError: string | null = null;
  if (fs.existsSync(runtimeFile)) {
    try {
      runtime = parseRuntime(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')));
      if (!runtime) {
        runtimeError = 'runtime file did not contain an object';
      }
    } catch (error) {
      runtimeError = formatError(error);
    }
  }

  const healthUrl = runtimeHealthUrl(runtime);
  const health = healthUrl ? await getHealth(healthUrl) : null;
  const pidAlive = isPidAlive(runtime?.pid);
  const healthOk = isHttpHealth(health) && health.statusCode === 200 && isAgentHealth(health.body);
  const status = {
    ok: Boolean(runtime && pidAlive && healthOk),
    runtimeFile,
    runtimeExists: fs.existsSync(runtimeFile),
    runtimeError,
    pidAlive,
    healthUrl,
    health,
    runtime,
  };

  console.log(JSON.stringify(status, null, 2));
  processWithKill.exitCode = status.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  processWithKill.exitCode = 1;
});
