// 数据文件剖析(host · L1 领域层 · tools/data)
// ---------------------------------------------------------------------------
// 职责:读取 CSV/TSV/XLSX 表格,逐列推断类型(数值/日期/布尔/文本)、统计缺失/去重/Top 值与
//       数值摘要,并给出图表建议。是数据分析闭环的「剖析」一环。纯函数、确定性。
// 依赖:同目录 table(安全读表)。导出:profileDataFile,并转出 readDataTable。

import { readDataTable, type DataFileOptions, type DataTable } from './table.js';

export type { DataFileOptions, DataTable } from './table.js';
export type DataTopValue = { value: string; count: number };
export type DataNumericSummary = { count: number; min: number; max: number; mean: number; sum: number };
export type DataColumnProfile = {
  name: string;
  index: number;
  type: string;
  nonEmpty: number;
  empty: number;
  unique: number;
  samples: string[];
  topValues: DataTopValue[];
  numeric?: DataNumericSummary;
};
export type DataChartSuggestion = { type: string; x: string; y?: string; reason: string };
export type DataProfile = {
  kind: 'data-profile';
  path: string;
  name: string;
  size: number;
  delimiter: string;
  rowCount: number;
  sampledRows: number;
  truncated: boolean;
  columns: DataColumnProfile[];
  chartSuggestions: DataChartSuggestion[];
  report: string;
};

export { readDataTable } from './table.js';

/**
 */
function numberValue(value: unknown): number | null {
  if (value === '') return null;
  const normalized = String(value).replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 */
function dateValue(value: unknown): number | null {
  if (!value || !/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(String(value))) return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

/**
 */
function inferType(values: string[], numericCount: number, dateCount: number, booleanCount: number): string {
  const filled = values.length;
  if (filled === 0) return 'empty';
  if (numericCount === filled) return 'number';
  if (dateCount === filled) return 'date';
  if (booleanCount === filled) return 'boolean';
  if (numericCount > 0 || dateCount > 0 || booleanCount > 0) return 'mixed';
  return 'text';
}

/**
 */
function profileColumn(rows: string[][], headers: string[], index: number): DataColumnProfile {
  const counts = new Map<string, number>();
  const values: string[] = [];
  const samples: string[] = [];
  const numbers: number[] = [];
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
  const column: DataColumnProfile = {
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
 */
function chartSuggestions(columns: DataColumnProfile[]): DataChartSuggestion[] {
  const textLike = columns.find((column) => column.type === 'text' && column.unique > 1 && column.unique <= 50);
  const number = columns.find((column) => column.type === 'number');
  const date = columns.find((column) => column.type === 'date');
  const suggestions: DataChartSuggestion[] = [];
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
 */
function buildReport({
  name,
  rowCount,
  columns,
  suggestions,
}: {
  name: string;
  rowCount: number;
  columns: DataColumnProfile[];
  suggestions: DataChartSuggestion[];
}): string {
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
 */
export function profileDataFile(options: DataFileOptions = {}): DataProfile {
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
