// 数据文件剖析(host · L1 领域层 · tools/data)
// ---------------------------------------------------------------------------
// 职责:读取 CSV/TSV/XLSX 表格,逐列推断类型(数值/日期/布尔/文本)、统计缺失/去重/Top 值与
//       数值摘要,并给出图表建议。是数据分析闭环的「剖析」一环。纯函数、确定性。
// 依赖:同目录 table(安全读表)。导出:profileDataFile,并转出 readDataTable。

import { readDataTable } from './table.js';

/**
 * @typedef {{ value: string, count: number }} DataTopValue
 * @typedef {{ count: number, min: number, max: number, mean: number, sum: number }} DataNumericSummary
 * @typedef {{ name: string, index: number, type: string, nonEmpty: number, empty: number, unique: number, samples: string[], topValues: DataTopValue[], numeric?: DataNumericSummary }} DataColumnProfile
 * @typedef {{ type: string, x: string, y?: string, reason: string }} DataChartSuggestion
 * @typedef {import('./table.js').DataTable} DataTable
 * @typedef {{ kind: 'data-profile', path: string, name: string, size: number, delimiter: string, rowCount: number, sampledRows: number, truncated: boolean, columns: DataColumnProfile[], chartSuggestions: DataChartSuggestion[], report: string }} DataProfile
 * @typedef {{ trustedRoot?: string, path?: string, maxBytes?: number, maxRows?: number }} DataFileOptions
 */

export { readDataTable } from './table.js';

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
 * 剖析数据文件:读表后逐列生成画像 + 图表建议 + 文字小结,返回 data-profile 结果。
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
