import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requestJson(baseUrl, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      `${baseUrl}${route}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk.toString();
        });
        response.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            reject(new Error(`${route} returned invalid JSON: ${error.message}`));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`${route} returned ${response.statusCode}: ${JSON.stringify(parsed)}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(scriptDir);
  const buildDir = path.join(repoRoot, 'build');
  const workspace = path.join(buildDir, 'kimi-api-smoke-workspace');
  const reportPath = path.join(buildDir, 'kimi-api-smoke-report.json');
  const apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;

  assert(apiKey, 'Set KIMI_API_KEY or MOONSHOT_API_KEY before running smoke:kimi-api');

  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'contract.txt'),
    'Contract draft. Party A, Party B, renewal date, payment terms.',
    'utf8',
  );

  const server = createServer({
    trustedRoot: workspace,
    kimiApiKey: apiKey,
    kimiBaseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL,
    kimiApiTimeoutMs: Number(process.env.KIMI_API_TIMEOUT_MS || 90_000),
    kimiApiMaxTokens: Number(process.env.KIMI_API_MAX_TOKENS || 2048),
    kimiModel: process.env.KIMI_MODEL,
    staticRoot: false,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const guest = await requestJson(baseUrl, '/api/auth/guest', {});
    assert(guest.token, 'Kimi API smoke guest auth did not return a token');
    const authHeaders = { authorization: `Bearer ${guest.token}` };

    const plan = await requestJson(baseUrl, '/api/kimi/plan', {
      trustedRoot: workspace,
      mode: 'cowork',
      summary: 'Contract draft. Party A, Party B, renewal date, payment terms.',
      prompt: '基于摘要输出三条中文整理建议。不要修改文件，不要运行命令。',
    }, authHeaders);

    assert(plan.ok === true, 'Kimi API smoke did not return ok=true');
    assert(plan.provider === 'kimi-api', 'Kimi API smoke returned unexpected provider');
    assert(typeof plan.text === 'string' && plan.text.length > 8, 'Kimi API smoke returned empty text');
    assert(/^run_/.test(plan.runId || ''), 'Kimi API smoke did not return a run id');
    assert(fs.existsSync(plan.runPath), 'Kimi API smoke did not persist a run record');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      workspace,
      baseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
      model: process.env.KIMI_MODEL || 'kimi-k2.6',
      durationMs: plan.durationMs,
      runId: plan.runId,
      runPath: plan.runPath,
      auth: {
        guestUserId: guest.userId,
      },
      textPreview: plan.text.slice(0, 500),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
