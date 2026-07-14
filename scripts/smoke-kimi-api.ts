// Kimi 真实 API 联调冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:用真实 KIMI/MOONSHOT API key 起一个本地 Host server(jail 在临时工作区),
//       走访客鉴权 → /api/kimi/plan,断言 provider=kimi-api、返回非空文本并落盘
//       了一条 run 记录,最后把结果写入 build/kimi-api-smoke-report.json。
// 用法:npm run smoke:kimi-api(经 run-host-node.mjs 跑本 .ts);
//       必须先设置 KIMI_API_KEY 或 MOONSHOT_API_KEY,否则启动即 exit 1。
// 依赖:apps/host/src/server.ts 的 createServer;真实 Moonshot/Kimi API 网络可达。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { AddressInfo } from 'node:http';
import type { HostServer } from '../apps/host/src/server.js';

type JsonRecord = Record<string, unknown>;
type RequestHeaders = Record<string, string>;
type GuestAuthResponse = JsonRecord & {
  token?: string;
  userId?: unknown;
};
type KimiPlanResponse = JsonRecord & {
  ok?: unknown;
  provider?: unknown;
  text?: string;
  runId?: string;
  runPath?: string;
  durationMs?: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson<T extends JsonRecord>(
  baseUrl: string,
  route: string,
  body: JsonRecord,
  headers: RequestHeaders = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${route} returned invalid JSON: ${message}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${route} returned ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function listenLocal(server: HostServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Kimi API smoke server did not bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function main(): Promise<void> {
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
    modelApiKey: apiKey,
    modelBaseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL,
    modelApiTimeoutMs: Number(process.env.KIMI_API_TIMEOUT_MS || 90_000),
    modelApiMaxTokens: Number(process.env.KIMI_API_MAX_TOKENS || 2048),
    model: process.env.KIMI_MODEL,
    staticRoot: false,
  });

  const baseUrl = await listenLocal(server);

  try {
    const guest = await requestJson<GuestAuthResponse>(baseUrl, '/api/auth/guest', {});
    assert(guest.token, 'Kimi API smoke guest auth did not return a token');
    const authHeaders = { authorization: `Bearer ${guest.token}` };

    const plan = await requestJson<KimiPlanResponse>(baseUrl, '/api/kimi/plan', {
      trustedRoot: workspace,
      mode: 'cowork',
      summary: 'Contract draft. Party A, Party B, renewal date, payment terms.',
      prompt: '基于摘要输出三条中文整理建议。不要修改文件，不要运行命令。',
    }, authHeaders);

    assert(plan.ok === true, 'Kimi API smoke did not return ok=true');
    assert(plan.provider === 'kimi-api', 'Kimi API smoke returned unexpected provider');
    assert(typeof plan.text === 'string' && plan.text.length > 8, 'Kimi API smoke returned empty text');
    assert(/^run_/.test(plan.runId || ''), 'Kimi API smoke did not return a run id');
    assert(plan.runPath, 'Kimi API smoke did not return a run path');
    assert(fs.existsSync(plan.runPath), 'Kimi API smoke did not persist a run record');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      workspace,
      baseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
      model: process.env.KIMI_MODEL || 'kimi-k2.7-code',
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
