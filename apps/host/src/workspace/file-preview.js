import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';

// Safe, bounded file preview for the UI: images/PDF come back as base64 data the
// client can render via a data: URL (the desktop CSP allows img-src data:), and
// text/markdown comes back as UTF-8. Everything is constrained to the trusted
// root by assertTrustedPath, and a byte cap stops huge files from being loaded.

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.py', '.sh', '.toml', '.ini',
  '.diff', '.patch',
]);

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function tablePreview(text, delimiter) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 101)
    .map((line) => splitDelimitedLine(line, delimiter));
  return { headers: rows[0] || [], rows: rows.slice(1), truncated: rows.length > 100 };
}

export function readFilePreview(filePath, { trustedRoot, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('path is required');
  }
  const root = path.resolve(trustedRoot || process.cwd());
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const safe = assertTrustedPath(resolved, root);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    const err = new Error('file not found');
    err.statusCode = 404;
    throw err;
  }
  const size = fs.statSync(safe).size;
  if (size > maxBytes) {
    const err = new Error(`file too large to preview (${size} bytes; max ${maxBytes})`);
    err.statusCode = 413;
    throw err;
  }
  const ext = path.extname(safe).toLowerCase();
  const name = path.basename(safe);

  if (ext === '.svg') {
    // SVG renders as text/markup; hand it back as text so the client can decide.
    return { kind: 'image', mime: 'image/svg+xml', name, size, base64: fs.readFileSync(safe).toString('base64') };
  }
  if (IMAGE_MIME[ext]) {
    return { kind: 'image', mime: IMAGE_MIME[ext], name, size, base64: fs.readFileSync(safe).toString('base64') };
  }
  if (ext === '.pdf') {
    return { kind: 'pdf', mime: 'application/pdf', name, size, base64: fs.readFileSync(safe).toString('base64') };
  }
  if (TEXT_EXT.has(ext)) {
    const text = fs.readFileSync(safe, 'utf8');
    const isMarkdown = ext === '.md' || ext === '.markdown';
    if (ext === '.csv' || ext === '.tsv') {
      return { kind: 'table', mime: 'text/plain', name, size, text, table: tablePreview(text, ext === '.tsv' ? '\t' : ',') };
    }
    if (ext === '.diff' || ext === '.patch') {
      return { kind: 'diff', mime: 'text/x-diff', name, size, text };
    }
    return { kind: isMarkdown ? 'markdown' : 'text', mime: 'text/plain', name, size, text };
  }
  return { kind: 'other', mime: 'application/octet-stream', name, size };
}
