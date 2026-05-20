import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeFile = path.resolve(process.env.MVP_RUNTIME_FILE || path.join(repoRoot, 'build', 'mvp-runtime.json'));

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

async function waitForStop(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

async function main() {
  if (!fs.existsSync(runtimeFile)) {
    console.log(JSON.stringify({ ok: true, stopped: false, reason: 'runtime file not found', runtimeFile }, null, 2));
    return;
  }

  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse runtime file ${runtimeFile}: ${error.message}`);
  }

  if (!isPidAlive(runtime.pid)) {
    fs.rmSync(runtimeFile, { force: true });
    console.log(JSON.stringify({ ok: true, stopped: false, reason: 'stale runtime file removed', runtimeFile, runtime }, null, 2));
    return;
  }

  if (runtime.pid === process.pid) {
    throw new Error('Refusing to stop the current process');
  }

  process.kill(runtime.pid, 'SIGTERM');
  const stopped = await waitForStop(runtime.pid);
  if (!stopped) {
    throw new Error(`Timed out waiting for Kimi Cowork MVP process to stop: ${runtime.pid}`);
  }

  if (fs.existsSync(runtimeFile)) {
    fs.rmSync(runtimeFile, { force: true });
  }
  console.log(JSON.stringify({ ok: true, stopped: true, runtimeFile, runtime }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
