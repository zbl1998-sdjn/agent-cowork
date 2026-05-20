import fs from 'node:fs';
import http from 'node:http';
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

async function main() {
  let runtime = null;
  let runtimeError = null;
  if (fs.existsSync(runtimeFile)) {
    try {
      runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    } catch (error) {
      runtimeError = error.message;
    }
  }

  const healthUrl = runtime ? `http://${runtime.host}:${runtime.port}/health` : null;
  const health = healthUrl ? await getHealth(healthUrl) : null;
  const pidAlive = runtime ? isPidAlive(runtime.pid) : false;
  const healthOk = health?.statusCode === 200 && health?.body?.ok === true && health?.body?.service === 'kimi-cowork-host';
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
  process.exit(status.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
