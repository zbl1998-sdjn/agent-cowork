// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../../security/path-policy.js';
import { parseXlsxTable } from './xlsx-table.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 5000;

/**
 * @typedef {{ kind: 'data-table', path: string, name: string, size: number, delimiter: string, headers: string[], rows: string[][], rowCount: number, sampledRows: number, truncated: boolean }} DataTable
 * @typedef {{ trustedRoot?: string, path?: string, maxBytes?: number, maxRows?: number }} DataFileOptions
 */

/**
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
export function splitDelimitedLine(line, delimiter) {
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

/**
 * @param {string} root
 * @param {unknown} filePath
 * @param {number} maxBytes
 * @returns {{ safe: string, size: number }}
 */
export function safeDataFile(root, filePath, maxBytes) {
  if (!filePath || typeof filePath !== 'string') throw new Error('path is required');
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const safe = assertTrustedPath(resolved, root);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    const err = /** @type {Error & { statusCode?: number }} */ (new Error('file not found'));
    err.statusCode = 404;
    throw err;
  }
  const size = fs.statSync(safe).size;
  if (size > maxBytes) {
    const err = /** @type {Error & { statusCode?: number }} */ (new Error(`file too large to analyze (${size} bytes; max ${maxBytes})`));
    err.statusCode = 413;
    throw err;
  }
  return { safe, size };
}

/**
 * @param {string} filePath
 * @param {string} text
 * @returns {string}
 */
export function delimiterFor(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsv') return '\t';
  if (ext === '.csv') return ',';
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  return firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
}

/**
 * @param {string} text
 * @param {string} delimiter
 * @param {number} maxRows
 * @returns {{ headers: string[], rows: string[][], totalRowsSeen: number, truncated: boolean }}
 */
export function parseTable(text, delimiter, maxRows) {
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
 * @param {DataFileOptions} [options]
 * @returns {DataTable}
 */
export function readDataTable({
  trustedRoot,
  path: filePath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRows = DEFAULT_MAX_ROWS,
} = {}) {
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
