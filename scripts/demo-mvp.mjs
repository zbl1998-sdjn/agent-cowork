import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const runtimeFile = path.resolve(process.env.MVP_RUNTIME_FILE || path.join(buildDir, 'mvp-runtime.json'));
const reportPath = path.join(buildDir, 'mvp-demo-report.json');
const serverLogPath = path.join(buildDir, 'mvp-demo-server.log');
const nodeBin = process.execPath;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getHealth(url) {
  return await new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ statusCode: response.statusCode, body });
        }
      });
    });
    request.on('error', (error) => resolve({ error: error.message }));
    request.setTimeout(1500, () => request.destroy(new Error('health request timed out')));
  });
}

async function getRuntimeStatus() {
  let runtime = null;
  let runtimeError = null;
  if (fs.existsSync(runtimeFile)) {
    try {
      runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    } catch (error) {
      runtimeError = error.message;
    }
  }

  const pidAlive = runtime ? isPidAlive(runtime.pid) : false;
  const healthUrl = runtime ? `http://${runtime.host}:${runtime.port}/health` : null;
  const health = healthUrl ? await getHealth(healthUrl) : null;
  const healthOk = health?.statusCode === 200 && health?.body?.ok === true && health?.body?.service === 'kimi-cowork-host';
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

async function waitForRuntime(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = await getRuntimeStatus();
  while (!lastStatus.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    lastStatus = await getRuntimeStatus();
  }
  return lastStatus;
}

function startMvpServer() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.appendFileSync(serverLogPath, `\n--- demo:mvp start ${new Date().toISOString()} ---\n`, 'utf8');
  const logFd = fs.openSync(serverLogPath, 'a');
  const child = spawn(nodeBin, [path.join(repoRoot, 'scripts', 'start-mvp.mjs')], {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  child.unref();
  return { pid: child.pid, logPath: serverLogPath };
}

function runStep(name, command, commandArgs) {
  console.log(`\n== ${name} ==`);
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
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

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { ok: false, parseError: error.message };
  }
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  const initialStatus = await getRuntimeStatus();
  let serverStart = null;

  if (!initialStatus.ok) {
    console.log('No healthy MVP runtime was found; starting npm run start:mvp equivalent in the background.');
    serverStart = startMvpServer();
  } else {
    console.log(`Reusing running MVP: ${initialStatus.runtime.url}`);
  }

  const readyStatus = await waitForRuntime();
  if (!readyStatus.ok) {
    throw new Error(`MVP runtime did not become healthy. Check ${serverLogPath}`);
  }
  console.log(`MVP ready: ${readyStatus.runtime.url}`);

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
  const report = {
    ok: steps.every((step) => step.ok) && audit?.ok === true && finalStatus.ok,
    completeGoal: audit?.completeGoal === true,
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
    summary: audit?.summary,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('\n== demo:mvp report ==');
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const report = {
    ok: false,
    completeGoal: false,
    generatedAt: new Date().toISOString(),
    error: error.stack || error.message,
  };
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error.stack || error.message);
  process.exit(1);
});
