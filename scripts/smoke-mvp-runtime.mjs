import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const reportPath = path.join(buildDir, 'mvp-runtime-smoke-report.json');
const nodeBin = process.execPath;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function getHealth(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(new Error(`${url} returned ${response.statusCode}: ${body}`));
              return;
            }
            resolve(JSON.parse(body));
          });
        });
        request.on('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error('health request timed out')));
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function runNodeScript(script, env) {
  return spawnSync(nodeBin, [path.join(repoRoot, 'scripts', script)], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  const port = await getFreePort();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-runtime-workspace-'));
  const runtimeFile = path.join(os.tmpdir(), `kcw-runtime-${process.pid}-${Date.now()}.json`);
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    TRUSTED_ROOT: workspace,
    MVP_RUNTIME_FILE: runtimeFile,
    NO_OPEN: '1',
  };

  const child = spawn(nodeBin, [path.join(repoRoot, 'scripts', 'start-mvp.mjs')], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    const health = await getHealth(`http://127.0.0.1:${port}/health`);
    assert(health.ok === true && health.service === 'kimi-cowork-host', 'runtime health check failed');
    assert(fs.existsSync(runtimeFile), 'runtime file was not written by start:mvp');
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert(runtime.pid === child.pid, 'runtime pid does not match child process');
    assert(runtime.port === port, 'runtime port mismatch');
    assert(runtime.workspace === workspace, 'runtime workspace mismatch');

    const statusBefore = runNodeScript('status-mvp.mjs', env);
    assert(statusBefore.status === 0, `status:mvp failed before stop: ${statusBefore.stderr || statusBefore.stdout}`);
    const statusPayload = JSON.parse(statusBefore.stdout);
    assert(statusPayload.ok === true && statusPayload.pidAlive === true, 'status:mvp did not report a live runtime');

    const stop = runNodeScript('stop-mvp.mjs', env);
    assert(stop.status === 0, `stop:mvp failed: ${stop.stderr || stop.stdout}`);
    const stopPayload = JSON.parse(stop.stdout);
    assert(stopPayload.ok === true && stopPayload.stopped === true, 'stop:mvp did not stop the runtime');

    const stopped = await new Promise((resolve) => {
      child.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 5000);
    });
    assert(stopped, 'start:mvp child did not exit after stop:mvp');
    assert(!fs.existsSync(runtimeFile), 'runtime file still exists after stop');

    const statusAfter = runNodeScript('status-mvp.mjs', env);
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
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      port,
      workspace,
      runtimeFile,
      error: error.stack || error.message,
      stdout: stdout.join('').split(/\r?\n/).slice(-40),
      stderr: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
