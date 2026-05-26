// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';

const ARTIFACT_ROOT_PARTS = ['.AgentCowork', 'artifacts'];
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.json', '.html', '.htm', '.log']);

/**
 * @typedef {{ safeRoot: string, root: string }} ArtifactRoot
 * @typedef {{ path: string, name: string, relativePath: string, extension: string, kind: string, size: number, mtime: string, viewable: boolean }} ArtifactItem
 * @typedef {{ trustedRoot?: string, limit?: number }} ListArtifactsOptions
 * @typedef {{ trustedRoot?: string, artifactPath?: string, newName?: unknown }} RenameArtifactOptions
 * @typedef {{ trustedRoot?: string, artifactPath?: string, maxBytes?: number }} RenderArtifactOptions
 */

/** @param {string} message @param {number} statusCode @returns {Error & { statusCode: number }} */
function httpError(message, statusCode) {
  const err = /** @type {Error & { statusCode: number }} */ (new Error(message));
  err.statusCode = statusCode;
  return err;
}

/** @param {string} trustedRoot @returns {ArtifactRoot} */
function safeArtifactRoot(trustedRoot) {
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const root = assertTrustedPath(path.join(safeRoot, ...ARTIFACT_ROOT_PARTS), safeRoot);
  return { safeRoot, root };
}

/** @param {string} parent @param {string} candidate @returns {boolean} */
function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** @param {string} trustedRoot @param {string} artifactPath @returns {{ root: string, safe: string }} */
function safeArtifactPath(trustedRoot, artifactPath) {
  const { root } = safeArtifactRoot(trustedRoot);
  const safe = assertTrustedPath(path.resolve(artifactPath), root);
  if (!isInside(root, safe)) {
    throw new Error('artifact path must stay inside .AgentCowork/artifacts');
  }
  return { root, safe };
}

/** @param {unknown} value @returns {string} */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** @param {string} filePath @returns {string} */
function artifactKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    return 'html-source';
  }
  if (ext === '.md') {
    return 'markdown';
  }
  if (ext === '.csv') {
    return 'table';
  }
  if (ext === '.xlsx') {
    return 'spreadsheet';
  }
  if (ext === '.docx') {
    return 'word';
  }
  if (ext === '.pptx') {
    return 'presentation';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext === '.json') {
    return 'json';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }
  return 'binary';
}

/** @param {string} root @param {string} filePath @returns {string} */
function artifactRelativePath(root, filePath) {
  const relative = path.relative(root, filePath).replace(/\\/g, '/');
  return ['.AgentCowork', 'artifacts', relative].join('/');
}

/** @param {string} root @param {string} filePath @returns {ArtifactItem} */
function artifactItem(root, filePath) {
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

/** @param {unknown} newName @returns {string} */
function safeArtifactName(newName) {
  const name = String(newName || '').trim();
  if (!name) {
    throw new Error('artifact newName is required');
  }
  if (name !== path.basename(name) || /[\\/]/.test(name)) {
    throw new Error('artifact newName must be a file name only');
  }
  if (name === '.' || name === '..') {
    throw new Error('artifact newName is invalid');
  }
  return name;
}

/** @param {string} root @param {string} current @param {ArtifactItem[]} files @param {number} limit */
function collectFiles(root, current, files, limit) {
  if (files.length >= limit || !fs.existsSync(current)) {
    return;
  }
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (files.length >= limit || entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, fullPath, files, limit);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push(artifactItem(root, fullPath));
  }
}

/** @param {ListArtifactsOptions} [options] @returns {ArtifactItem[]} */
export function listArtifacts({ trustedRoot, limit = 20 } = {}) {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const { root } = safeArtifactRoot(trustedRoot);
  /** @type {ArtifactItem[]} */
  const files = [];
  collectFiles(root, root, files, Math.max(1, Math.min(Number(limit) || 20, 100)));
  return files
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

/** @param {RenameArtifactOptions} [options] @returns {ArtifactItem} */
export function renameArtifact({ trustedRoot, artifactPath, newName } = {}) {
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

/** @param {RenderArtifactOptions} [options] @returns {string} */
export function renderArtifactHtml({ trustedRoot, artifactPath, maxBytes = 512 * 1024 } = {}) {
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
