// 制品目录登记:列出/重命名 .AgentCowork/artifacts 下的制品并生成只读预览页(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:扫描制品根目录、按类型归类(markdown/table/word/...)、安全重命名、把
//       文本制品渲染成单页 HTML 预览。所有路径都经过 path-jail 校验,严禁逃出制品目录。
// 依赖:node:fs、node:path、security/path-policy(assertTrustedPath 路径围栏)
// 导出:listArtifacts(列目录)、renameArtifact(改名)、renderArtifactHtml(预览页)
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath, assertTrustedPathForCreate } from '../security/path-policy.js';
import {
  authorizeCatalogArtifactFile,
  renameCatalogArtifactWithOwner,
} from './artifact-catalog-security.js';
import { isAuthorizedLiveArtifactPair } from './artifact-catalog-manifest.js';
import { renderArtifactPreviewPage } from './artifact-catalog-render.js';

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
  liveArtifactId?: string;
};
export type ListArtifactsOptions = { trustedRoot?: string; limit?: number; context?: unknown };
export type RenameArtifactOptions = { trustedRoot?: string; artifactPath?: string; newName?: unknown; context?: unknown };
export type RenderArtifactOptions = { trustedRoot?: string; artifactPath?: string; maxBytes?: number; context?: unknown };

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
function artifactItem(root: string, filePath: string, liveArtifactId?: string): ArtifactItem {
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
    ...(liveArtifactId ? { liveArtifactId } : {}),
  };
}

/** 校验重命名目标只能是纯文件名(禁止含路径分隔符或 . / ..),防止目录穿越。 */
function safeArtifactName(newName: unknown): string {
  const name = typeof newName === 'string' ? newName : '';
  if (!name) throw new Error('artifact newName is required');
  if (name !== path.basename(name) || /[\\/]/.test(name)) {
    throw new Error('artifact newName must be a file name only');
  }
  const deviceStem = (name.split('.')[0] || '').replace(/[. ]+$/u, '');
  if (name === '.'
    || name === '..'
    || /[\u0000-\u001f\u007f<>:"|?*]/u.test(name)
    || /[. ]$/u.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(deviceStem)) {
    throw new Error('artifact newName is invalid');
  }
  return name;
}

/** 递归收集制品文件至 limit 条;跳过符号链接以避免越权读到目录外。 */
function collectFiles(
  trustedRoot: string,
  root: string,
  current: string,
  files: ArtifactItem[],
  limit: number,
  context: unknown,
): void {
  if (files.length >= limit || !fs.existsSync(current)) {
    return;
  }
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (files.length >= limit || entry.isSymbolicLink()) continue;
    if (current === root && entry.name.toLowerCase() === '.owners') continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(trustedRoot, root, fullPath, files, limit, context);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const authorization = authorizeCatalogArtifactFile(trustedRoot, fullPath, context);
      const extension = path.extname(fullPath).toLowerCase();
      const liveArtifactId = ['.html', '.htm'].includes(extension)
        && isAuthorizedLiveArtifactPair({
          trustedRoot,
          filePath: fullPath,
          context,
          authorization,
        })
        ? path.basename(fullPath, extension)
        : undefined;
      files.push(artifactItem(root, fullPath, liveArtifactId));
    } catch (error) {
      if ((error as HttpStatusError).statusCode !== 404) throw error;
    }
  }
}

/** 列出制品目录下的文件,按修改时间倒序返回(limit 夹在 1..100)。 */
export function listArtifacts({ trustedRoot, limit = 20, context }: ListArtifactsOptions = {}): ArtifactItem[] {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const { root } = safeArtifactRoot(trustedRoot);
  const files: ArtifactItem[] = [];
  collectFiles(trustedRoot, root, root, files, Math.max(1, Math.min(Number(limit) || 20, 100)), context);
  return files
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

/** 在制品目录内重命名一个文件;目标已存在或越界都会报错。 */
export function renameArtifact({
  trustedRoot,
  artifactPath,
  newName,
  context,
}: RenameArtifactOptions = {}): ArtifactItem {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!artifactPath) {
    throw new Error('artifact path is required');
  }
  const { root, safe } = safeArtifactPath(trustedRoot, artifactPath);
  const authorization = authorizeCatalogArtifactFile(trustedRoot, safe, context);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    throw httpError('artifact not found', 404);
  }
  const target = assertTrustedPathForCreate(
    path.join(path.dirname(safe), safeArtifactName(newName)),
    root,
  );
  if (!isInside(root, target)) {
    throw new Error('artifact rename target must stay inside .AgentCowork/artifacts');
  }
  if (target === safe) {
    return artifactItem(root, safe);
  }
  renameCatalogArtifactWithOwner({
    trustedRoot,
    source: safe,
    target,
    context,
    authorization,
  });
  return artifactItem(root, target);
}

/** 把单个制品渲染成只读 HTML 预览页;文本类才内联内容,二进制/超大只展示元数据。 */
export function renderArtifactHtml({
  trustedRoot,
  artifactPath,
  maxBytes = 512 * 1024,
  context,
}: RenderArtifactOptions = {}): string {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!artifactPath) {
    throw new Error('artifact path is required');
  }
  const { root, safe } = safeArtifactPath(trustedRoot, artifactPath);
  authorizeCatalogArtifactFile(trustedRoot, safe, context);
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
  return renderArtifactPreviewPage({
    name,
    relativePath,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    content,
  });
}
