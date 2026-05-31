// 安全读表(host · L1 领域层 · tools/data)
// ---------------------------------------------------------------------------
// 职责:把工作区内的 CSV/TSV/XLSX 安全读取为统一的 DataTable(表头 + 行)。校验可信根、
//       限制体积(默认 4MB)与行数(默认 5000),支持带引号转义的分隔符解析与分隔符自动嗅探。
// 依赖:L0 security/path-policy + 同目录 xlsx-table。导出:readDataTable 及若干纯解析器。
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../../security/path-policy.js';
import { parseXlsxTable } from './xlsx-table.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 5000;

export type DataTable = {
  kind: 'data-table';
  path: string;
  name: string;
  size: number;
  delimiter: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  sampledRows: number;
  truncated: boolean;
};
export type DataFileOptions = { trustedRoot?: string; path?: string; maxBytes?: number; maxRows?: number };
export type ParsedTable = { headers: string[]; rows: string[][]; totalRowsSeen: number; truncated: boolean };

/**
 * 切分一行分隔文本为单元格,正确处理双引号包裹与 "" 转义。
 */
export function splitDelimitedLine(line: string, delimiter: string): string[] {
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

/**
 * 校验数据文件:锚定可信根、确认存在且为普通文件、超 maxBytes 抛 413,返回安全路径与大小。
 */
export function safeDataFile(root: string, filePath: unknown, maxBytes: number): { safe: string; size: number } {
  if (!filePath || typeof filePath !== 'string') throw new Error('path is required');
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const safe = assertTrustedPath(resolved, root);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    const err = new Error('file not found') as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  const size = fs.statSync(safe).size;
  if (size > maxBytes) {
    const err = new Error(`file too large to analyze (${size} bytes; max ${maxBytes})`) as Error & { statusCode?: number };
    err.statusCode = 413;
    throw err;
  }
  return { safe, size };
}

/**
 * 决定分隔符:.tsv→制表符、.csv→逗号;其余按首行制表符与逗号谁多来嗅探。
 */
export function delimiterFor(filePath: string, text: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsv') return '\t';
  if (ext === '.csv') return ',';
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  return firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
}

/**
 * 解析分隔文本为 { headers, rows },首行作表头,超 maxRows 截断并标记 truncated。
 */
export function parseTable(text: string, delimiter: string, maxRows: number): ParsedTable {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  const rows = lines.slice(0, maxRows + 1).map((line) => splitDelimitedLine(line, delimiter));
  const headers = (rows[0] || []).map((header, index) => header || `Column ${index + 1}`);
  return {
    headers,
    rows: rows.slice(1),
    totalRowsSeen: Math.max(lines.length - 1, 0),
    truncated: lines.length > maxRows + 1,
  };
}

/**
 * 安全读取数据文件为统一 DataTable:校验 → 按 .xlsx/分隔文本分流解析 → 归一化输出。
 */
export function readDataTable({
  trustedRoot,
  path: filePath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRows = DEFAULT_MAX_ROWS,
}: DataFileOptions = {}): DataTable {
  if (!trustedRoot) throw new Error('trustedRoot is required');
  const root = path.resolve(trustedRoot);
  const { safe, size } = safeDataFile(root, filePath, maxBytes);
  const rowLimit = Math.max(1, Math.min(Number(maxRows) || DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS));
  const isXlsx = path.extname(safe).toLowerCase() === '.xlsx';
  const text = isXlsx ? '' : fs.readFileSync(safe, 'utf8');
  const delimiter = isXlsx ? 'xlsx' : delimiterFor(safe, text);
  const table = isXlsx ? parseXlsxTable(fs.readFileSync(safe), rowLimit) : parseTable(text, delimiter, rowLimit);
  return {
    kind: 'data-table',
    path: path.relative(root, safe).replace(/\\/g, '/'),
    name: path.basename(safe),
    size,
    delimiter: delimiter === '\t' ? 'tab' : delimiter,
    headers: table.headers,
    rows: table.rows,
    rowCount: table.totalRowsSeen,
    sampledRows: table.rows.length,
    truncated: table.truncated,
  };
}
