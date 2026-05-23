import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';

const ARTIFACT_ROOT_PARTS = ['.KimiCowork', 'artifacts'];
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.json', '.html', '.htm', '.log']);

function artifactRoot(trustedRoot) {
  return path.join(trustedRoot, ...ARTIFACT_ROOT_PARTS);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeArtifactPath(trustedRoot, artifactPath) {
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), trustedRoot);
  const root = artifactRoot(safeRoot);
  const safe = assertTrustedPath(path.resolve(artifactPath), safeRoot);
  if (!isInside(root, safe)) {
    throw new Error('artifact path must stay inside .KimiCowork/artifacts');
  }
  return { root, safe };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  if (ext === '.json') {
    return 'json';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }
  return 'binary';
}

function artifactRelativePath(root, filePath) {
  const relative = path.relative(root, filePath).replace(/\\/g, '/');
  return ['.KimiCowork', 'artifacts', relative].join('/');
}

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
    const stat = fs.statSync(fullPath);
    files.push({
      path: fullPath,
      name: entry.name,
      relativePath: artifactRelativePath(root, fullPath),
      extension: path.extname(entry.name).toLowerCase(),
      kind: artifactKind(fullPath),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      viewable: true,
    });
  }
}

export function listArtifacts({ trustedRoot, limit = 20 } = {}) {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const root = artifactRoot(safeRoot);
  const files = [];
  collectFiles(root, root, files, Math.max(1, Math.min(Number(limit) || 20, 100)));
  return files
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

export function renderArtifactHtml({ trustedRoot, artifactPath, maxBytes = 512 * 1024 } = {}) {
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!artifactPath) {
    throw new Error('artifact path is required');
  }
  const { root, safe } = safeArtifactPath(trustedRoot, artifactPath);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    const err = new Error('artifact not found');
    err.statusCode = 404;
    throw err;
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
