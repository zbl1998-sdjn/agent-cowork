import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const defaultReportPath = path.join(buildDir, 'windows-paths-smoke-report.json');
const archiveRequested = process.env.WINDOWS_PATHS_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.WINDOWS_PATHS_REPORT_DIR || path.join(repoRoot, 'reports', 'windows-paths'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `windows-paths-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertInside(child, parent, label) {
  const relative = path.relative(parent, child);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} escaped expected parent: ${child}`);
}

function buildLongDirectory(root) {
  let current = path.join(root, '长路径');
  for (let index = 1; index <= 10; index += 1) {
    current = path.join(current, `第${index}层-中文目录-用于验证长路径处理`);
  }
  return current;
}

async function postJson(baseUrl, route, body, expectedStatus = 200) {
  const headers = { 'content-type': 'application/json' };
  if (body?.idempotencyKey) headers['idempotency-key'] = body.idempotencyKey;
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${text}`);
  return payload;
}

async function getJson(baseUrl, route, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${text}`);
  return payload;
}

async function getText(baseUrl, route, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  assert(response.status === expectedStatus, `${route} returned ${response.status}: ${text}`);
  return text;
}

async function main() {
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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert(health.ok === true && health.service === 'agent-cowork-host', 'health check failed');

    const workspaceInfo = await (await fetch(`${baseUrl}/api/workspace`)).json();
    assert(workspaceInfo.trustedRoot === workspace, 'workspace endpoint lost unicode trustedRoot');

    const tree = await postJson(baseUrl, '/api/files/tree', { root: workspace });
    assert(tree.files.some((entry) => entry.path === '会议纪要/周报-含中文.md'), 'tree missing unicode file');

    const read = await postJson(baseUrl, '/api/files/read', { trustedRoot: workspace, path: sourcePath });
    assert(read.content.includes('中文路径 smoke'), 'read endpoint lost unicode content');
    assert(typeof read.sha256 === 'string' && read.sha256.length === 64, 'read endpoint missing sha256');

    const previewFile = await postJson(baseUrl, '/api/files/preview', { trustedRoot: workspace, path: sourcePath });
    assert(previewFile.kind === 'markdown' && previewFile.text.includes('中文路径 smoke'), 'preview endpoint lost unicode markdown');

    const longRead = await postJson(baseUrl, '/api/files/read', { trustedRoot: workspace, path: longFilePath });
    assert(longRead.content.includes('长路径内容'), 'read endpoint failed long path file');

    const search = await postJson(baseUrl, '/api/files/search', {
      trustedRoot: workspace,
      query: 'trustedRoot jail',
      maxResults: 5,
      includeContent: true,
    });
    assert(search.results.some((entry) => entry.path === '会议纪要/周报-含中文.md'), 'search endpoint missing unicode file');

    const bundle = await postJson(baseUrl, '/api/context/bundle', {
      trustedRoot: workspace,
      paths: [sourcePath, longFilePath],
      maxTextSize: 4096,
    });
    assert(bundle.files.length === 2, `context bundle expected 2 files, got ${bundle.files.length}`);

    const escaped = await postJson(
      baseUrl,
      '/api/files/read',
      { trustedRoot: workspace, path: outsidePath },
      400,
    );
    assert(/trusted root|escaped/i.test(escaped.error), `escaped read returned unexpected error: ${escaped.error}`);

    const sensitive = await postJson(
      baseUrl,
      '/api/file-ops/preview',
      {
        trustedRoot: workspace,
        operations: [{ type: 'write', path: path.join(workspace, '.ssh', 'id_rsa'), content: 'nope' }],
      },
      400,
    );
    assert(/sensitive|blocked/i.test(sensitive.error), `sensitive path returned unexpected error: ${sensitive.error}`);
    assert(!fs.existsSync(path.join(workspace, '.ssh', 'id_rsa')), 'sensitive preview wrote a file');

    let junctionEscape = 'not-created';
    try {
      fs.symlinkSync(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
      const blockedJunction = await postJson(
        baseUrl,
        '/api/file-ops/preview',
        {
          trustedRoot: workspace,
          operations: [{ type: 'write', path: junctionWritePath, content: 'must not escape' }],
        },
        400,
      );
      assert(/trusted root|escaped|sensitive/i.test(blockedJunction.error), `junction escape returned unexpected error: ${blockedJunction.error}`);
      assert(!fs.existsSync(path.join(outsideDir, '不应写入.md')), 'junction escape wrote outside trustedRoot');
      junctionEscape = 'blocked';
    } catch (err) {
      if (err?.code !== 'EPERM' && err?.code !== 'EACCES') {
        throw err;
      }
      junctionEscape = `skipped:${err.code}`;
    }

    const uploaded = await postJson(baseUrl, '/api/uploads/import', {
      trustedRoot: workspace,
      files: [{
        relativePath: '上传资料/客户-张三.md',
        contentBase64: Buffer.from('上传中文内容\n', 'utf8').toString('base64'),
        size: Buffer.byteLength('上传中文内容\n', 'utf8'),
      }],
    });
    assert(uploaded.imported.length === 1, 'upload import did not return one file');
    assert(uploaded.imported[0].path.includes('Agent_Cowork上传'), 'upload path did not use workspace upload root');
    assert(fs.readFileSync(uploaded.imported[0].path, 'utf8').includes('上传中文内容'), 'upload import lost unicode content');

    const artifactsBefore = await getJson(baseUrl, `/api/artifacts?trustedRoot=${encodeURIComponent(workspace)}&limit=10`);
    assert(artifactsBefore.artifacts.some((item) => item.path === seededArtifactPath), 'artifact catalog missing unicode artifact');
    const artifactHtml = await getText(baseUrl, `/api/artifacts/view?trustedRoot=${encodeURIComponent(workspace)}&path=${encodeURIComponent(seededArtifactPath)}`);
    assert(artifactHtml.includes('初始产物') && artifactHtml.includes('中文 artifact 预览'), 'artifact view lost unicode content');
    const renamedArtifact = await postJson(baseUrl, '/api/artifacts/rename', {
      trustedRoot: workspace,
      path: seededArtifactPath,
      newName: '初始产物-已改名.md',
      idempotencyKey: 'windows-paths-artifact-rename',
    });
    assert(renamedArtifact.artifact.path === renamedArtifactPath, 'artifact rename returned unexpected path');
    assert(fs.existsSync(renamedArtifactPath), 'artifact rename did not update disk');

    const operations = [
      { type: 'write', path: artifactPath, content: '# 中文验收报告\n\n- 长路径和中文路径通过。\n' },
      { type: 'rename', path: sourcePath, newName: '周报-已改名.md' },
      { type: 'move', from: longFilePath, to: movedPath },
    ];
    const preview = await postJson(baseUrl, '/api/file-ops/preview', { trustedRoot: workspace, operations });
    assert(preview.operations.length === 3, `preview expected 3 operations, got ${preview.operations.length}`);
    assert(/^fop_/.test(preview.fileOperationApprovalId || ''), 'preview did not issue approval');

    const applied = await postJson(baseUrl, '/api/file-ops/apply', {
      trustedRoot: workspace,
      operations,
      fileOperationApprovalId: preview.fileOperationApprovalId,
      idempotencyKey: 'windows-paths-apply',
    });
    assert(applied.applied.length === 3, `apply expected 3 operations, got ${applied.applied.length}`);
    assert(fs.existsSync(artifactPath), 'unicode artifact was not written');
    assert(!fs.existsSync(sourcePath), 'source path still exists after rename');
    assert(fs.existsSync(renamedPath), 'unicode file was not renamed');
    assert(!fs.existsSync(longFilePath), 'long path source still exists after move');
    assert(fs.existsSync(movedPath), 'long path file was not moved');

    const rollback = await postJson(baseUrl, '/api/file-ops/rollback', {
      trustedRoot: workspace,
      applied: applied.applied,
      rollbackApprovalId: applied.rollbackApprovalId,
      idempotencyKey: 'windows-paths-rollback',
    });
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
      uploadPath: uploaded.imported[0].path,
      renamedArtifactPath,
      bundledFiles: bundle.files.length,
      applied: applied.applied.length,
      rolledBack: rollback.rolledBack.length,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      workspace,
      longFilePath,
      longPathLength: path.resolve(longFilePath).length,
      reportPath,
      error: error.stack || error.message,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    reportPath,
    error: error.stack || error.message,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error.stack || error.message);
  process.exit(1);
});
