// 离线本地能力冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:删除所有网络相关环境变量并劫持 globalThis.fetch 强制只允许 127.0.0.1/localhost,
//       验证断网场景下本地文件能力仍可用——健康检查、工作区、文件树/读取、file-ops
//       preview→apply 写入、运行时依赖(含 on-demand 安装模式)与审计 JSONL;同时断言
//       模型类接口(/api/kimi/plan)在 enableKimiApi:false 下返回 503 且给出"本地文件
//       功能仍可离线使用 / 需要模型回复时请联网"的边界提示。报告落地 reports/offline-local。
// 用法:npm run smoke:offline-local(即 node scripts/run-host-node.mjs scripts/smoke-offline-local.ts);
//       断言失败即 exit 1 阻断。
// 依赖:apps/host 的 createServer 与 JsonlWriter 审计写入;顶层 await 直接执行(无 main 包装)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';
import type { AddressInfo } from 'node:http';
import type { HostServer } from '../apps/host/src/server.js';

const NETWORK_ENV = [
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_BASE_URL',
  'MOONSHOT_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;
for (const key of NETWORK_ENV) Reflect.deleteProperty(process.env, key);

type JsonRecord = Record<string, unknown>;
type RequestBody = JsonRecord & { idempotencyKey?: string };
type SmokeReport = {
  ok: boolean;
  mode: 'offline-local';
  generatedAt: string;
  workspace: string;
  checks: Record<string, string>;
};

const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function fetchInputUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = fetchInputUrl(input);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), `offline smoke blocked non-local fetch: ${url.href}`);
  return originalFetch(input, init);
};

function assertInside(child: string, parent: string, label: string): void {
  const relative = path.relative(parent, child);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escaped expected parent: ${child}`);
}

async function fetchJson<T = JsonRecord>(url: string): Promise<T> {
  const response = await fetch(url);
  return await response.json() as T;
}

async function postJson<T = JsonRecord>(
  baseUrl: string,
  route: string,
  body: RequestBody,
  expectedStatus = 200,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (body?.idempotencyKey) headers['idempotency-key'] = body.idempotencyKey;
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json() as T;
  assert.equal(response.status, expectedStatus, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function listenLocal(server: HostServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'offline smoke server did not bind to a TCP port');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const buildRoot = path.join(repoRoot, 'build');
const workspace = path.join(buildRoot, 'offline-local-smoke-workspace');
assertInside(workspace, buildRoot, 'offline smoke workspace');
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
const sourcePath = path.join(workspace, 'docs', 'offline-note.md');
fs.writeFileSync(sourcePath, '# 离线任务\n- 本地文件仍可读写\n', 'utf8');

const auditPath = path.join(workspace, '.AgentCowork', 'audit', 'offline.jsonl');
const server = createServer({
  trustedRoot: workspace,
  journalWriter: new JsonlWriter(auditPath),
  enableKimiApi: false,
  requireAuth: false,
});

const baseUrl = await listenLocal(server);
const report: SmokeReport = {
  ok: false,
  mode: 'offline-local',
  generatedAt: new Date().toISOString(),
  workspace,
  checks: {},
};

try {
  const health = await fetchJson<{ ok?: unknown }>(`${baseUrl}/health`);
  assert.equal(health.ok, true);
  report.checks.health = 'passed';

  const workspaceInfo = await fetchJson<{ trustedRoot?: unknown }>(`${baseUrl}/api/workspace`);
  assert.equal(workspaceInfo.trustedRoot, workspace);
  report.checks.workspace = 'passed';

  const tree = await postJson<{ files: Array<{ path?: unknown }> }>(baseUrl, '/api/files/tree', { root: workspace });
  assert.ok(tree.files.some((item) => item.path === 'docs/offline-note.md'));
  const read = await postJson<{ content?: string }>(baseUrl, '/api/files/read', { trustedRoot: workspace, path: sourcePath });
  assert.match(String(read.content), /本地文件仍可读写/);
  report.checks.localFiles = 'passed';

  const artifactPath = path.join(workspace, '.AgentCowork', 'artifacts', 'offline-result.md');
  const preview = await postJson<{ fileOperationApprovalId?: string }>(baseUrl, '/api/file-ops/preview', {
    trustedRoot: workspace,
    operations: [{ type: 'write', path: artifactPath, content: '# 离线结果\n\n本地写入成功。\n' }],
  });
  assert.match(String(preview.fileOperationApprovalId), /^fop_/);
  const applied = await postJson<{ applied: Array<{ status?: unknown }> }>(baseUrl, '/api/file-ops/apply', {
    trustedRoot: workspace,
    operations: [{ type: 'write', path: artifactPath, content: '# 离线结果\n\n本地写入成功。\n' }],
    fileOperationApprovalId: preview.fileOperationApprovalId,
    idempotencyKey: 'offline-local-write',
  });
  const firstApplied = applied.applied.at(0);
  assert.ok(firstApplied);
  assert.equal(firstApplied.status, 'applied');
  assert.equal(fs.existsSync(artifactPath), true);
  report.checks.localWrite = 'passed';

  const runtime = await fetchJson<{ ok?: unknown; dependencies: Array<{ installMode?: unknown }> }>(
    `${baseUrl}/api/runtime/dependencies`,
  );
  assert.equal(runtime.ok, true);
  assert.ok(runtime.dependencies.some((item) => item.installMode === 'on-demand'));
  report.checks.runtimeDependencies = 'passed';

  const kimi = await postJson<{ error?: unknown }>(
    baseUrl,
    '/api/kimi/plan',
    { trustedRoot: workspace, prompt: '总结离线文件' },
    503,
  );
  assert.match(String(kimi.error), /本地文件功能仍可离线使用/);
  assert.match(String(kimi.error), /需要模型回复时请联网/);
  report.checks.modelNetworkBoundary = 'passed';

  const audit = fs.readFileSync(auditPath, 'utf8');
  assert.match(audit, /"action":"write"/);
  report.checks.audit = 'passed';
  report.ok = true;
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const reportDir = path.join(repoRoot, 'reports', 'offline-local');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `offline-local-smoke-${stamp}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Offline local smoke passed: ${reportPath}`);
