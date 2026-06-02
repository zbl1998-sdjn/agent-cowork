// Windows 中文/长路径与路径越权防护冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:在含中文目录名、超 260 字符长路径的工作区起本地 Host server(jail 在
//       trustedRoot),逐项验证 files tree/read/preview/search、context bundle、
//       uploads import、artifacts 列举/查看/改名、file-ops 预览/应用/回滚等接口
//       对 Unicode 与长路径的正确处理;并断言越权读取、敏感路径(.ssh)、
//       junction 软链逃逸均被拦在 trustedRoot 内,审计日志记录写/移动动作。
//       结果写 build/windows-paths-smoke-report.json(WINDOWS_PATHS_ARCHIVE=1
//       时改写到 reports/windows-paths 带时间戳归档,失败 ok=false 退 1)。
// 用法:npm run smoke:windows-paths(经 run-host-node.mjs 跑本 .ts);无需网络。
// 依赖:apps/host/src/server.ts 的 createServer;storage/jsonl-writer 审计写入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { HostServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const defaultReportPath = path.join(buildDir, 'windows-paths-smoke-report.json');
const archiveRequested = process.env.WINDOWS_PATHS_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.WINDOWS_PATHS_REPORT_DIR || path.join(repoRoot, 'reports', 'windows-paths'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `windows-paths-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;

type JsonRecord = Record<string, unknown>;
type RequestBody = JsonRecord & { idempotencyKey?: string };
type ErrorResponse = { error?: unknown };
type PathEntry = { path?: unknown };
type FileTreeResponse = { files: PathEntry[] };
type FileReadResponse = { content?: unknown; sha256?: unknown };
type FilePreviewResponse = { kind?: unknown; text?: unknown };
type SearchResponse = { results: PathEntry[] };
type ContextBundleResponse = { files: unknown[] };
type UploadResponse = { imported: Array<{ path?: unknown }> };
type ArtifactCatalogResponse = { artifacts: Array<{ path?: unknown }> };
type ArtifactRenameResponse = { artifact?: { path?: unknown } };
type FileOpsPreviewResponse = { operations: unknown[]; fileOperationApprovalId?: unknown };
type FileOpsApplyResponse = { applied: JsonRecord[]; rollbackApprovalId?: unknown };
type FileOpsRollbackResponse = { rolledBack: unknown[] };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isErrorWithCode(error: unknown): error is Error & { code?: string } {
  return error instanceof Error;
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function assertInside(child: string, parent: string, label: string): void {
  const relative = path.relative(parent, child);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escaped expected parent: ${child}`);
}

function buildLongDirectory(root: string): string {
  let current = path.join(root, '长路径');
  for (let index = 1; index <= 10; index += 1) {
    current = path.join(current, `第${index}层-中文目录-用于验证长路径处理`);
  }
  return current;
}

async function postJson<T = JsonRecord>(
  baseUrl: string,
  route: string,
  body: RequestBody,
  expectedStatus = 200,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof body.idempotencyKey === 'string' && body.idempotencyKey) {
    headers['idempotency-key'] = body.idempotencyKey;
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = (text ? JSON.parse(text) : {}) as T;
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${text}`);
  return payload;
}

async function getJson<T = JsonRecord>(baseUrl: string, route: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const payload = (text ? JSON.parse(text) : {}) as T;
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${text}`);
  return payload;
}

async function getText(baseUrl: string, route: string, expectedStatus = 200): Promise<string> {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${text}`);
  return text;
}

async function closeServer(server: HostServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const smokeRoot = path.join(buildDir, '06-F1-中文路径-smoke');
  assertInside(smokeRoot, buildDir, '06-F1 smoke root');
  fs.rmSync(smokeRoot, { recursive: true, force: true });

  const workspace = path.join(smokeRoot, '用户-张三-资料工作区');
  const sourceDir = path.join(workspace, '会议纪要');
  const sourcePath = path.join(sourceDir, '周报-含中文.md');
  const longDir = buildLongDirectory(workspace);
  const longFilePath = path.join(longDir, '长路径文件-最终.md');
  const outsidePath = path.join(smokeRoot, '逃逸目标.txt');
  const outsideDir = path.join(smokeRoot, '外部目录');
  const junctionPath = path.join(workspace, '链接到外部目录');
  const junctionWritePath = path.join(junctionPath, '不应写入.md');
  const artifactPath = path.join(workspace, '.AgentCowork', 'artifacts', '中文验收报告.md');
  const seededArtifactPath = path.join(workspace, '.AgentCowork', 'artifacts', '初始产物.md');
  const renamedArtifactPath = path.join(workspace, '.AgentCowork', 'artifacts', '初始产物-已改名.md');
  const renamedPath = path.join(sourceDir, '周报-已改名.md');
  const movedPath = path.join(longDir, '归档-长路径文件-最终.md');
  const auditPath = path.join(workspace, '.AgentCowork', 'audit', 'windows-paths.jsonl');

  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(longDir, { recursive: true });
  fs.mkdirSync(path.dirname(seededArtifactPath), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(sourcePath, '# 周报\n\n- 中文路径 smoke\n- trustedRoot jail\n', 'utf8');
  fs.writeFileSync(longFilePath, '长路径内容：Agent Cowork 应该能读取这个文件。\n', 'utf8');
  fs.writeFileSync(outsidePath, 'outside root', 'utf8');
  fs.writeFileSync(seededArtifactPath, '# 初始产物\n\n中文 artifact 预览。\n', 'utf8');

  assert(path.resolve(longFilePath).length > 260, `long path was not long enough: ${path.resolve(longFilePath).length}`);

  const server = createServer({
    trustedRoot: workspace,
    journalWriter: new JsonlWriter(auditPath),
    requireAuth: false,
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', (error: Error) => reject(error));
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert(address && typeof address === 'object', 'windows paths smoke server did not bind to a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await (await fetch(`${baseUrl}/health`)).json() as { ok?: unknown; service?: unknown };
    assert(health.ok === true && health.service === 'agent-cowork-host', 'health check failed');

    const workspaceInfo = await (await fetch(`${baseUrl}/api/workspace`)).json() as { trustedRoot?: unknown };
    assert(workspaceInfo.trustedRoot === workspace, 'workspace endpoint lost unicode trustedRoot');

    const tree = await postJson<FileTreeResponse>(baseUrl, '/api/files/tree', { root: workspace });
    assert(Array.isArray(tree.files), 'tree response missing files array');
    assert(tree.files.some((entry) => entry.path === '会议纪要/周报-含中文.md'), 'tree missing unicode file');

    const read = await postJson<FileReadResponse>(baseUrl, '/api/files/read', { trustedRoot: workspace, path: sourcePath });
    assert(typeof read.content === 'string' && read.content.includes('中文路径 smoke'), 'read endpoint lost unicode content');
    assert(typeof read.sha256 === 'string' && read.sha256.length === 64, 'read endpoint missing sha256');

    const previewFile = await postJson<FilePreviewResponse>(baseUrl, '/api/files/preview', { trustedRoot: workspace, path: sourcePath });
    assert(
      previewFile.kind === 'markdown' && typeof previewFile.text === 'string' && previewFile.text.includes('中文路径 smoke'),
      'preview endpoint lost unicode markdown',
    );

    const longRead = await postJson<FileReadResponse>(baseUrl, '/api/files/read', { trustedRoot: workspace, path: longFilePath });
    assert(typeof longRead.content === 'string' && longRead.content.includes('长路径内容'), 'read endpoint failed long path file');

    const search = await postJson<SearchResponse>(baseUrl, '/api/files/search', {
      trustedRoot: workspace,
      query: 'trustedRoot jail',
      maxResults: 5,
      includeContent: true,
    });
    assert(Array.isArray(search.results), 'search response missing results array');
    assert(search.results.some((entry) => entry.path === '会议纪要/周报-含中文.md'), 'search endpoint missing unicode file');

    const bundle = await postJson<ContextBundleResponse>(baseUrl, '/api/context/bundle', {
      trustedRoot: workspace,
      paths: [sourcePath, longFilePath],
      maxTextSize: 4096,
    });
    assert(Array.isArray(bundle.files), 'context bundle response missing files array');
    assert(bundle.files.length === 2, `context bundle expected 2 files, got ${bundle.files.length}`);

    const escaped = await postJson<ErrorResponse>(
      baseUrl,
      '/api/files/read',
      { trustedRoot: workspace, path: outsidePath },
      400,
    );
    assert(/trusted root|escaped/i.test(String(escaped.error)), `escaped read returned unexpected error: ${escaped.error}`);

    const sensitive = await postJson<ErrorResponse>(
      baseUrl,
      '/api/file-ops/preview',
      {
        trustedRoot: workspace,
        operations: [{ type: 'write', path: path.join(workspace, '.ssh', 'id_rsa'), content: 'nope' }],
      },
      400,
    );
    assert(/sensitive|blocked/i.test(String(sensitive.error)), `sensitive path returned unexpected error: ${sensitive.error}`);
    assert(!fs.existsSync(path.join(workspace, '.ssh', 'id_rsa')), 'sensitive preview wrote a file');

    let junctionEscape = 'not-created';
    try {
      fs.symlinkSync(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
      const blockedJunction = await postJson<ErrorResponse>(
        baseUrl,
        '/api/file-ops/preview',
        {
          trustedRoot: workspace,
          operations: [{ type: 'write', path: junctionWritePath, content: 'must not escape' }],
        },
        400,
      );
      assert(
        /trusted root|escaped|sensitive/i.test(String(blockedJunction.error)),
        `junction escape returned unexpected error: ${blockedJunction.error}`,
      );
      assert(!fs.existsSync(path.join(outsideDir, '不应写入.md')), 'junction escape wrote outside trustedRoot');
      junctionEscape = 'blocked';
    } catch (err: unknown) {
      const code = isErrorWithCode(err) ? err.code : undefined;
      if (code !== 'EPERM' && code !== 'EACCES') {
        throw err;
      }
      junctionEscape = `skipped:${code}`;
    }

    const uploaded = await postJson<UploadResponse>(baseUrl, '/api/uploads/import', {
      trustedRoot: workspace,
      files: [{
        relativePath: '上传资料/客户-张三.md',
        contentBase64: Buffer.from('上传中文内容\n', 'utf8').toString('base64'),
        size: Buffer.byteLength('上传中文内容\n', 'utf8'),
      }],
    });
    assert(Array.isArray(uploaded.imported), 'upload import response missing imported array');
    const uploadedFile = uploaded.imported[0];
    assert(uploadedFile && typeof uploadedFile.path === 'string', 'upload import did not return a file path');
    assert(uploaded.imported.length === 1, 'upload import did not return one file');
    assert(uploadedFile.path.includes('Agent_Cowork上传'), 'upload path did not use workspace upload root');
    assert(fs.readFileSync(uploadedFile.path, 'utf8').includes('上传中文内容'), 'upload import lost unicode content');

    const artifactsBefore = await getJson<ArtifactCatalogResponse>(baseUrl, `/api/artifacts?trustedRoot=${encodeURIComponent(workspace)}&limit=10`);
    assert(Array.isArray(artifactsBefore.artifacts), 'artifact catalog response missing artifacts array');
    assert(artifactsBefore.artifacts.some((item) => item.path === seededArtifactPath), 'artifact catalog missing unicode artifact');
    const artifactHtml = await getText(baseUrl, `/api/artifacts/view?trustedRoot=${encodeURIComponent(workspace)}&path=${encodeURIComponent(seededArtifactPath)}`);
    assert(artifactHtml.includes('初始产物') && artifactHtml.includes('中文 artifact 预览'), 'artifact view lost unicode content');
    const renamedArtifact = await postJson<ArtifactRenameResponse>(baseUrl, '/api/artifacts/rename', {
      trustedRoot: workspace,
      path: seededArtifactPath,
      newName: '初始产物-已改名.md',
      idempotencyKey: 'windows-paths-artifact-rename',
    });
    assert(renamedArtifact.artifact?.path === renamedArtifactPath, 'artifact rename returned unexpected path');
    assert(fs.existsSync(renamedArtifactPath), 'artifact rename did not update disk');

    const operations = [
      { type: 'write', path: artifactPath, content: '# 中文验收报告\n\n- 长路径和中文路径通过。\n' },
      { type: 'rename', path: sourcePath, newName: '周报-已改名.md' },
      { type: 'move', from: longFilePath, to: movedPath },
    ];
    const preview = await postJson<FileOpsPreviewResponse>(baseUrl, '/api/file-ops/preview', { trustedRoot: workspace, operations });
    assert(Array.isArray(preview.operations), 'file operation preview response missing operations array');
    assert(preview.operations.length === 3, `preview expected 3 operations, got ${preview.operations.length}`);
    assert(typeof preview.fileOperationApprovalId === 'string', 'preview did not return string approval id');
    const fileOperationApprovalId = preview.fileOperationApprovalId;
    assert(/^fop_/.test(fileOperationApprovalId), 'preview did not issue approval');

    const applied = await postJson<FileOpsApplyResponse>(baseUrl, '/api/file-ops/apply', {
      trustedRoot: workspace,
      operations,
      fileOperationApprovalId,
      idempotencyKey: 'windows-paths-apply',
    });
    assert(Array.isArray(applied.applied), 'file operation apply response missing applied array');
    assert(applied.applied.length === 3, `apply expected 3 operations, got ${applied.applied.length}`);
    assert(fs.existsSync(artifactPath), 'unicode artifact was not written');
    assert(!fs.existsSync(sourcePath), 'source path still exists after rename');
    assert(fs.existsSync(renamedPath), 'unicode file was not renamed');
    assert(!fs.existsSync(longFilePath), 'long path source still exists after move');
    assert(fs.existsSync(movedPath), 'long path file was not moved');

    const rollback = await postJson<FileOpsRollbackResponse>(baseUrl, '/api/file-ops/rollback', {
      trustedRoot: workspace,
      applied: applied.applied,
      rollbackApprovalId: applied.rollbackApprovalId,
      idempotencyKey: 'windows-paths-rollback',
    });
    assert(Array.isArray(rollback.rolledBack), 'file operation rollback response missing rolledBack array');
    assert(rollback.rolledBack.length === 3, `rollback expected 3 entries, got ${rollback.rolledBack.length}`);
    assert(fs.existsSync(sourcePath), 'rollback did not restore original unicode file');
    assert(fs.existsSync(longFilePath), 'rollback did not restore original long path file');
    assert(!fs.existsSync(movedPath), 'rollback left moved long-path file behind');

    const audit = fs.readFileSync(auditPath, 'utf8');
    assert(audit.includes('"action":"write"'), 'audit missing write action');
    assert(audit.includes('"action":"move"'), 'audit missing move action');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      workspace,
      sourcePath,
      longFilePath,
      longPathLength: path.resolve(longFilePath).length,
      artifactPath,
      auditPath,
      reportPath,
      escapedError: escaped.error,
      junctionEscape,
      uploadPath: uploadedFile.path,
      renamedArtifactPath,
      bundledFiles: bundle.files.length,
      applied: applied.applied.length,
      rolledBack: rollback.rolledBack.length,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error: unknown) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      workspace,
      longFilePath,
      longPathLength: path.resolve(longFilePath).length,
      reportPath,
      error: errorDetails(error),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(errorDetails(error));
    Reflect.set(process, 'exitCode', 1);
  } finally {
    await closeServer(server);
  }
}

main().catch((error: unknown) => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    reportPath,
    error: errorDetails(error),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(errorDetails(error));
  process.exit(1);
});
