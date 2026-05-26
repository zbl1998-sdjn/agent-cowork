import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../../security/path-policy.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 5000;

/**
 * @typedef {{ value: string, count: number }} DataTopValue
 * @typedef {{ count: number, min: number, max: number, mean: number, sum: number }} DataNumericSummary
 * @typedef {{ name: string, index: number, type: string, nonEmpty: number, empty: number, unique: number, samples: string[], topValues: DataTopValue[], numeric?: DataNumericSummary }} DataColumnProfile
 * @typedef {{ type: string, x: string, y?: string, reason: string }} DataChartSuggestion
 * @typedef {{ kind: 'data-table', path: string, name: string, size: number, delimiter: string, headers: string[], rows: string[][], rowCount: number, sampledRows: number, truncated: boolean }} DataTable
 * @typedef {{ kind: 'data-profile', path: string, name: string, size: number, delimiter: string, rowCount: number, sampledRows: number, truncated: boolean, columns: DataColumnProfile[], chartSuggestions: DataChartSuggestion[], report: string }} DataProfile
 * @typedef {{ trustedRoot?: string, path?: string, maxBytes?: number, maxRows?: number }} DataFileOptions
 */

/**
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
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

/**
 * @param {string} root
 * @param {unknown} filePath
 * @param {number} maxBytes
 * @returns {{ safe: string, size: number }}
 */
function safeDataFile(root, filePath, maxBytes) {
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
function delimiterFor(filePath, text) {
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
function parseTable(text, delimiter, maxRows) {
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
 * @param {unknown} value
 * @returns {number | null}
 */
function numberValue(value) {
  if (value === '') return null;
  const normalized = String(value).replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function dateValue(value) {
  if (!value || !/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(value))) return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

/**
 * @param {string[]} values
 * @param {number} numericCount
 * @param {number} dateCount
 * @param {number} booleanCount
 * @returns {string}
 */
function inferType(values, numericCount, dateCount, booleanCount) {
  const filled = values.length;
  if (filled === 0) return 'empty';
  if (numericCount === filled) return 'number';
  if (dateCount === filled) return 'date';
  if (booleanCount === filled) return 'boolean';
  if (numericCount > 0 || dateCount > 0 || booleanCount > 0) return 'mixed';
  return 'text';
}

/**
 * @param {string[][]} rows
 * @param {string[]} headers
 * @param {number} index
 * @returns {DataColumnProfile}
 */
function profileColumn(rows, headers, index) {
  const counts = new Map();
  const values = [];
  const samples = [];
  const numbers = [];
  let empty = 0;
  let dateCount = 0;
  let booleanCount = 0;

  for (const row of rows) {
    const value = String(row[index] ?? '').trim();
    if (!value) {
      empty += 1;
      continue;
    }
    values.push(value);
    if (samples.length < 3) samples.push(value);
    counts.set(value, (counts.get(value) || 0) + 1);
    const n = numberValue(value);
    if (n !== null) numbers.push(n);
    if (dateValue(value) !== null) dateCount += 1;
    if (/^(true|false|yes|no|0|1)$/i.test(value)) booleanCount += 1;
  }

  const type = inferType(values, numbers.length, dateCount, booleanCount);
  /** @type {DataColumnProfile} */
  const column = {
    name: headers[index] || `Column ${index + 1}`,
    index,
    type,
    nonEmpty: values.length,
    empty,
    unique: counts.size,
    samples,
    topValues: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([value, count]) => ({ value, count })),
  };

  if (numbers.length > 0) {
    const sum = numbers.reduce((acc, value) => acc + value, 0);
    column.numeric = {
      count: numbers.length,
      min: Math.min(...numbers),
      max: Math.max(...numbers),
      mean: Number((sum / numbers.length).toFixed(4)),
      sum: Number(sum.toFixed(4)),
    };
  }

  return column;
}

/**
 * @param {DataColumnProfile[]} columns
 * @returns {DataChartSuggestion[]}
 */
function chartSuggestions(columns) {
  const textLike = columns.find((column) => column.type === 'text' && column.unique > 1 && column.unique <= 50);
  const number = columns.find((column) => column.type === 'number');
  const date = columns.find((column) => column.type === 'date');
  const suggestions = [];
  if (textLike && number) {
    suggestions.push({ type: 'bar', x: textLike.name, y: number.name, reason: 'category plus numeric column' });
  }
  if (date && number) {
    suggestions.push({ type: 'line', x: date.name, y: number.name, reason: 'date plus numeric column' });
  }
  if (number) {
    suggestions.push({ type: 'histogram', x: number.name, reason: 'numeric distribution' });
  }
  return suggestions.slice(0, 3);
}

/**
 * @param {{ name: string, rowCount: number, columns: DataColumnProfile[], suggestions: DataChartSuggestion[] }} input
 * @returns {string}
 */
function buildReport({ name, rowCount, columns, suggestions }) {
  const numeric = columns.filter((column) => column.type === 'number').length;
  const missing = columns.filter((column) => column.empty > 0).map((column) => column.name);
  const lines = [
    `${name}: ${rowCount} rows, ${columns.length} columns.`,
    `Detected ${numeric} numeric column${numeric === 1 ? '' : 's'}.`,
  ];
  if (missing.length > 0) lines.push(`Columns with missing values: ${missing.slice(0, 5).join(', ')}.`);
  if (suggestions.length > 0) lines.push(`Suggested chart: ${suggestions[0].type} using ${suggestions[0].x}${suggestions[0].y ? ` and ${suggestions[0].y}` : ''}.`);
  return lines.join(' ');
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
  const text = fs.readFileSync(safe, 'utf8');
  const delimiter = delimiterFor(safe, text);
  const table = parseTable(text, delimiter, Math.max(1, Math.min(Number(maxRows) || DEFAULT_MAX_ROWS, DEFAULT_MAX_ROWS)));
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

/**
 * @param {DataFileOptions} [options]
 * @returns {DataProfile}
 */
export function profileDataFile(options = {}) {
  const table = readDataTable(options);
  const columnCount = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0);
  const columns = Array.from({ length: columnCount }, (_, index) => profileColumn(table.rows, table.headers, index));
  const suggestions = chartSuggestions(columns);
  return {
    kind: 'data-profile',
    path: table.path,
    name: table.name,
    size: table.size,
    delimiter: table.delimiter,
    rowCount: table.rowCount,
    sampledRows: table.rows.length,
    truncated: table.truncated,
    columns,
    chartSuggestions: suggestions,
    report: buildReport({ name: table.name, rowCount: table.rowCount, columns, suggestions }),
  };
}
