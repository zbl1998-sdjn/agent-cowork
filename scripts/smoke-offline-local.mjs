import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

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
];
for (const key of NETWORK_ENV) delete process.env[key];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), `offline smoke blocked non-local fetch: ${url.href}`);
  return originalFetch(input, init);
};

function assertInside(child, parent, label) {
  const relative = path.relative(parent, child);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escaped expected parent: ${child}`);
}

async function postJson(baseUrl, route, body, expectedStatus = 200) {
  const headers = { 'content-type': 'application/json' };
  if (body?.idempotencyKey) headers['idempotency-key'] = body.idempotencyKey;
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
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

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const baseUrl = `http://127.0.0.1:${server.address().port}`;
const report = {
  ok: false,
  mode: 'offline-local',
  generatedAt: new Date().toISOString(),
  workspace,
  checks: {},
};

try {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.ok, true);
  report.checks.health = 'passed';

  const workspaceInfo = await (await fetch(`${baseUrl}/api/workspace`)).json();
  assert.equal(workspaceInfo.trustedRoot, workspace);
  report.checks.workspace = 'passed';

  const tree = await postJson(baseUrl, '/api/files/tree', { root: workspace });
  assert.ok(tree.files.some((item) => item.path === 'docs/offline-note.md'));
  const read = await postJson(baseUrl, '/api/files/read', { trustedRoot: workspace, path: sourcePath });
  assert.match(read.content, /本地文件仍可读写/);
  report.checks.localFiles = 'passed';

  const artifactPath = path.join(workspace, '.AgentCowork', 'artifacts', 'offline-result.md');
  const preview = await postJson(baseUrl, '/api/file-ops/preview', {
    trustedRoot: workspace,
    operations: [{ type: 'write', path: artifactPath, content: '# 离线结果\n\n本地写入成功。\n' }],
  });
  assert.match(preview.fileOperationApprovalId, /^fop_/);
  const applied = await postJson(baseUrl, '/api/file-ops/apply', {
    trustedRoot: workspace,
    operations: [{ type: 'write', path: artifactPath, content: '# 离线结果\n\n本地写入成功。\n' }],
    fileOperationApprovalId: preview.fileOperationApprovalId,
    idempotencyKey: 'offline-local-write',
  });
  assert.equal(applied.applied[0].status, 'applied');
  assert.equal(fs.existsSync(artifactPath), true);
  report.checks.localWrite = 'passed';

  const runtime = await (await fetch(`${baseUrl}/api/runtime/dependencies`)).json();
  assert.equal(runtime.ok, true);
  assert.ok(runtime.dependencies.some((item) => item.installMode === 'on-demand'));
  report.checks.runtimeDependencies = 'passed';

  const kimi = await postJson(baseUrl, '/api/kimi/plan', { trustedRoot: workspace, prompt: '总结离线文件' }, 503);
  assert.match(kimi.error, /本地文件功能仍可离线使用/);
  assert.match(kimi.error, /需要模型回复时请联网/);
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
