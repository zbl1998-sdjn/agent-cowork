// 制品目录登记:列出/重命名 .AgentCowork/artifacts 下的制品并生成只读预览页(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:扫描制品根目录、按类型归类(markdown/table/word/...)、安全重命名、把
//       文本制品渲染成单页 HTML 预览。所有路径都经过 path-jail 校验,严禁逃出制品目录。
// 依赖:node:fs、node:path、security/path-policy(assertTrustedPath 路径围栏)
// 导出:listArtifacts(列目录)、renameArtifact(改名)、renderArtifactHtml(预览页)
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';

const ARTIFACT_ROOT_PARTS = ['.AgentCowork', 'artifacts'];
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.json', '.html', '.htm', '.log']);

type ArtifactRoot = { safeRoot: string; root: string };
type HttpStatusError = Error & { statusCode: number };

export type ArtifactItem = {
  path: string;
  name: string;
  relativePath: string;
  extension: string;
  kind: string;
  size: number;
  mtime: string;
  viewable: boolean;
};
export type ListArtifactsOptions = { trustedRoot?: string; limit?: number };
export type RenameArtifactOptions = { trustedRoot?: string; artifactPath?: string; newName?: unknown };
export type RenderArtifactOptions = { trustedRoot?: string; artifactPath?: string; maxBytes?: number };

/** 构造带 HTTP 状态码的错误(供路由层映射成响应)。 */
function httpError(message: string, statusCode: number): HttpStatusError {
  const err = new Error(message) as HttpStatusError;
  err.statusCode = statusCode;
  return err;
}

/** 把可信工作根解析成受围栏保护的制品根目录(.AgentCowork/artifacts)。 */
function safeArtifactRoot(trustedRoot: string): ArtifactRoot {
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const root = assertTrustedPath(path.join(safeRoot, ...ARTIFACT_ROOT_PARTS), safeRoot);
  return { safeRoot, root };
}

/** 判断 candidate 是否落在 parent 目录内(用相对路径不以 .. 开头来判定)。 */
function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 校验单个制品文件路径必须留在制品目录内,返回围栏后的安全路径。 */
function safeArtifactPath(trustedRoot: string, artifactPath: string): { root: string; safe: string } {
  const { root } = safeArtifactRoot(trustedRoot);
  const safe = assertTrustedPath(path.resolve(artifactPath), root);
  if (!isInside(root, safe)) {
    throw new Error('artifact path must stay inside .AgentCowork/artifacts');
  }
  return { root, safe };
}

/** HTML 转义,防止制品内容在预览页里被当作标签注入。 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 按扩展名把制品归类成前端可识别的 kind(html/markdown/word/...)。 */
function artifactKind(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html-source';
  if (ext === '.md') return 'markdown';
  if (ext === '.csv') return 'table';
  if (ext === '.xlsx') return 'spreadsheet';
  if (ext === '.docx') return 'word';
  if (ext === '.pptx') return 'presentation';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.json') return 'json';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

/** 生成对外展示的相对路径(统一用正斜杠,带 .AgentCowork/artifacts 前缀)。 */
function artifactRelativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).replace(/\\/g, '/');
  return ['.AgentCowork', 'artifacts', relative].join('/');
}

/** 读取文件 stat,组装成对外的制品条目(含大小、修改时间、kind 等)。 */
function artifactItem(root: string, filePath: string): ArtifactItem {
  const stat = fs.statSync(filePath);
  const name = path.basename(filePath);
  return {
    path: filePath,
    name,
    relativePath: artifactRelativePath(root, filePath),
    extension: path.extname(name).toLowerCase(),
    kind: artifactKind(filePath),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    viewable: true,
  };
}

/** 校验重命名目标只能是纯文件名(禁止含路径分隔符或 . / ..),防止目录穿越。 */
function safeArtifactName(newName: unknown): string {
  const name = String(newName || '').trim();
  if (!name) throw new Error('artifact newName is required');
  if (name !== path.basename(name) || /[\\/]/.test(name)) {
    throw new Error('artifact newName must be a file name only');
  }
  if (name === '.' || name === '..') throw new Error('artifact newName is invalid');
  return name;
}

/** 递归收集制品文件至 limit 条;跳过符号链接以避免越权读到目录外。 */
function collectFiles(root: string, current: string, files: ArtifactItem[], limit: number): void {
  if (files.length >= limit || !fs.existsSync(current)) {
    return;
  }
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (files.length >= limit || entry.isSymbolicLink()) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, fullPath, files, limit);
      continue;
    }
    if (entry.isFile()) files.push(artifactItem(root, fullPath));
  }
}

/** 列出制品目录下的文件,按修改时间倒序返回(limit 夹在 1..100)。 */
export function listArtifacts({ trustedRoot, limit = 20 }: ListArtifactsOptions = {}): ArtifactItem[] {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const { root } = safeArtifactRoot(trustedRoot);
  const files: ArtifactItem[] = [];
  collectFiles(root, root, files, Math.max(1, Math.min(Number(limit) || 20, 100)));
  return files
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

/** 在制品目录内重命名一个文件;目标已存在或越界都会报错。 */
export function renameArtifact({ trustedRoot, artifactPath, newName }: RenameArtifactOptions = {}): ArtifactItem {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!artifactPath) {
    throw new Error('artifact path is required');
  }
  const { root, safe } = safeArtifactPath(trustedRoot, artifactPath);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    throw httpError('artifact not found', 404);
  }
  const target = path.join(path.dirname(safe), safeArtifactName(newName));
  if (!isInside(root, target)) {
    throw new Error('artifact rename target must stay inside .AgentCowork/artifacts');
  }
  if (target === safe) {
    return artifactItem(root, safe);
  }
  if (fs.existsSync(target)) {
    throw httpError('artifact target already exists', 409);
  }
  fs.renameSync(safe, target);
  return artifactItem(root, target);
}

/** 把单个制品渲染成只读 HTML 预览页;文本类才内联内容,二进制/超大只展示元数据。 */
export function renderArtifactHtml({ trustedRoot, artifactPath, maxBytes = 512 * 1024 }: RenderArtifactOptions = {}): string {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!artifactPath) {
    throw new Error('artifact path is required');
  }
  const { root, safe } = safeArtifactPath(trustedRoot, artifactPath);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    throw httpError('artifact not found', 404);
  }

  const stat = fs.statSync(safe);
  const ext = path.extname(safe).toLowerCase();
  const name = path.basename(safe);
  const relativePath = artifactRelativePath(root, safe);
  const canReadText = TEXT_EXTENSIONS.has(ext) && stat.size <= maxBytes;
  const content = canReadText
    ? fs.readFileSync(safe, 'utf8')
    : `Binary or large artifact preview is metadata-only.\nPath: ${relativePath}\nSize: ${stat.size} bytes`;
  const escaped = escapeHtml(content);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(name)} · Artifact Live Page</title>
    <style>
      :root { color-scheme: light; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
      body { margin: 0; background: #f5f6f2; color: #20211f; }
      main { max-width: 980px; margin: 0 auto; padding: 32px 24px 48px; }
      header { margin-bottom: 20px; }
      h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
      .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #646860; font-size: 13px; }
      .meta span { border: 1px solid #d9ded5; background: #fff; border-radius: 8px; padding: 6px 9px; }
      pre { overflow: auto; white-space: pre-wrap; word-break: break-word; background: #fff; border: 1px solid #d9ded5; border-radius: 8px; padding: 18px; line-height: 1.55; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Artifact Live Page</h1>
        <div class="meta">
          <span>${escapeHtml(name)}</span>
          <span>${escapeHtml(relativePath)}</span>
          <span>${stat.size} bytes</span>
          <span>${escapeHtml(stat.mtime.toISOString())}</span>
        </div>
      </header>
      <pre>${escaped}</pre>
    </main>
  </body>
</html>`;
}
