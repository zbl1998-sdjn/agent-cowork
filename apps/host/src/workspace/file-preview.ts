// 文件预览(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:为 UI 提供安全、限量的文件预览:图片/PDF 以 base64 返回(供 data: URL 渲染),
//       文本/Markdown/diff 以 UTF-8 返回,CSV/TSV 额外解析成表格。路径限定可信根、字节封顶。
// 依赖:L0 path-policy。导出:readFilePreview。
import fs from 'node:fs';
import path from 'node:path';
import { assertReadableWorkspacePath } from '../security/path-policy.js';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const HARD_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
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

export type TablePreview = { headers: string[]; rows: string[][]; truncated: boolean };
export type BinaryPreview = {
  kind: 'image' | 'pdf';
  mime: string;
  name: string;
  size: number;
  base64: string;
};
export type TextPreview = {
  kind: 'markdown' | 'text' | 'diff';
  mime: string;
  name: string;
  size: number;
  text: string;
};
export type DelimitedPreview = {
  kind: 'table';
  mime: string;
  name: string;
  size: number;
  text: string;
  table: TablePreview;
};
export type OtherPreview = {
  kind: 'other';
  mime: string;
  name: string;
  size: number;
};
export type FilePreview = BinaryPreview | TextPreview | DelimitedPreview | OtherPreview;
export type FilePreviewOptions = { trustedRoot?: string; maxBytes?: number };

function cappedMaxBytes(value: unknown, fallback = DEFAULT_MAX_BYTES): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), HARD_MAX_BYTES);
}

function splitDelimitedLine(line: string, delimiter: ',' | '\t'): string[] {
  const cells: string[] = [];
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

function tablePreview(text: string, delimiter: ',' | '\t'): TablePreview {
  const rows = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 101)
    .map((line) => splitDelimitedLine(line, delimiter));
  return { headers: rows[0] || [], rows: rows.slice(1), truncated: rows.length > 100 };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * 读取文件预览:按扩展名分流(图片/PDF→base64;文本/diff→文本;CSV/TSV→表格;其余→other),受可信根与字节上限约束。
 */
export function readFilePreview(filePath: string, { trustedRoot, maxBytes = DEFAULT_MAX_BYTES }: FilePreviewOptions = {}): FilePreview {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('path is required');
  }
  const root = path.resolve(trustedRoot || process.cwd());
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const safe = assertReadableWorkspacePath(resolved, root);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    throw httpError(404, 'file not found');
  }
  const size = fs.statSync(safe).size;
  const byteLimit = cappedMaxBytes(maxBytes);
  if (size > byteLimit) {
    throw httpError(413, `file too large to preview (${size} bytes; max ${byteLimit})`);
  }
  const ext = path.extname(safe).toLowerCase();
  const name = path.basename(safe);

  if (ext === '.svg') {
    // SVG 仍按图片 data URL 返回,但入口已受路径与大小限制保护。
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
