import { profileDataFile, readDataTable } from './profile.js';

const MAX_CHART_POINTS = 12;

/**
 * @typedef {import('./profile.js').DataFileOptions} DataFileOptions
 * @typedef {import('./profile.js').DataTable} DataTable
 * @typedef {import('./profile.js').DataProfile} DataProfile
 * @typedef {import('./profile.js').DataColumnProfile} DataColumnProfile
 * @typedef {{ kind: 'bar' | 'line', title: string, data: { labels: string[], values: number[], label: string } }} DataChart
 * @typedef {{ kind: 'data-analysis', path: string, name: string, rowCount: number, columnCount: number, sampledRows: number, truncated: boolean, insights: string[], chart: DataChart | null, reportMarkdown: string, profile: DataProfile }} DataAnalysis
 */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberValue(value) {
  if (value === '') return null;
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string[]} headers
 * @param {string} name
 * @returns {number}
 */
function columnIndex(headers, name) {
  return headers.findIndex((header) => String(header).trim() === String(name).trim());
}

/**
 * @param {DataProfile} profile
 * @returns {DataColumnProfile | null}
 */
function firstNumericColumn(profile) {
  return profile.columns.find((column) => column.type === 'number') || null;
}

/**
 * @param {DataProfile} profile
 * @returns {DataColumnProfile | null}
 */
function firstCategoryColumn(profile) {
  return profile.columns.find((column) => column.type === 'text' && column.unique > 1 && column.unique <= 50) || null;
}

/**
 * @param {DataProfile} profile
 * @param {DataTable} table
 * @returns {DataChart | null}
 */
function buildBarChart(profile, table) {
  const category = firstCategoryColumn(profile);
  const numeric = firstNumericColumn(profile);
  if (!category || !numeric) return null;
  const categoryIdx = columnIndex(table.headers, category.name);
  const numericIdx = columnIndex(table.headers, numeric.name);
  if (categoryIdx < 0 || numericIdx < 0) return null;

  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const row of table.rows) {
    const label = String(row[categoryIdx] ?? '').trim();
    const value = numberValue(row[numericIdx]);
    if (!label || value === null) continue;
    totals.set(label, (totals.get(label) || 0) + value);
  }
  const points = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CHART_POINTS);
  if (points.length === 0) return null;
  return {
    kind: 'bar',
    title: `${numeric.name} by ${category.name}`,
    data: {
      labels: points.map(([label]) => label),
      values: points.map(([, value]) => Number(value.toFixed(4))),
      label: numeric.name,
    },
  };
}

/**
 * @param {DataProfile} profile
 * @param {DataTable} table
 * @returns {DataChart | null}
 */
function buildLineChart(profile, table) {
  const date = profile.columns.find((column) => column.type === 'date');
  const numeric = firstNumericColumn(profile);
  if (!date || !numeric) return null;
  const dateIdx = columnIndex(table.headers, date.name);
  const numericIdx = columnIndex(table.headers, numeric.name);
  if (dateIdx < 0 || numericIdx < 0) return null;
  /** @type {{ label: string, value: number }[]} */
  const points = [];
  for (const row of table.rows) {
    const label = String(row[dateIdx] ?? '').trim();
    const value = numberValue(row[numericIdx]);
    if (label && value !== null) {
      points.push({ label, value });
    }
    if (points.length >= MAX_CHART_POINTS) break;
  }
  if (points.length === 0) return null;
  return {
    kind: 'line',
    title: `${numeric.name} over ${date.name}`,
    data: {
      labels: points.map((point) => point.label),
      values: points.map((point) => Number(point.value.toFixed(4))),
      label: numeric.name,
    },
  };
}

/**
 * @param {DataProfile} profile
 * @param {DataTable} table
 * @returns {DataChart | null}
 */
function buildChart(profile, table) {
  const preferred = profile.chartSuggestions[0]?.type;
  if (preferred === 'line') return buildLineChart(profile, table) || buildBarChart(profile, table);
  return buildBarChart(profile, table) || buildLineChart(profile, table);
}

/**
 * @param {DataProfile} profile
 * @param {DataChart | null} chart
 * @returns {string[]}
 */
function buildInsights(profile, chart) {
  const numericColumns = profile.columns.filter((column) => column.type === 'number');
  const missingColumns = profile.columns.filter((column) => column.empty > 0);
  const insights = [
    `${profile.name}: ${profile.rowCount} rows, ${profile.columns.length} columns.`,
    `Numeric columns: ${numericColumns.length}.`,
  ];
  if (missingColumns.length > 0) {
    insights.push(`Missing values in: ${missingColumns.map((column) => column.name).slice(0, 5).join(', ')}.`);
  }
  if (chart) {
    insights.push(`Recommended chart: ${chart.kind} (${chart.title}).`);
  }
  return insights;
}

/**
 * @param {DataProfile} profile
 * @returns {string}
 */
function markdownTable(profile) {
  const lines = [
    '| Column | Type | Non-empty | Missing | Unique | Notes |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const column of profile.columns) {
    const notes = column.numeric
      ? `min ${column.numeric.min}, max ${column.numeric.max}, mean ${column.numeric.mean}`
      : column.topValues.map((item) => `${item.value} (${item.count})`).join('; ');
    lines.push(`| ${column.name} | ${column.type} | ${column.nonEmpty} | ${column.empty} | ${column.unique} | ${notes || '-'} |`);
  }
  return lines.join('\n');
}

/**
 * @param {DataProfile} profile
 * @param {DataChart | null} chart
 * @param {string[]} insights
 * @returns {string}
 */
function buildReportMarkdown(profile, chart, insights) {
  const chartLines = chart
    ? [
        `- Type: ${chart.kind}`,
        `- Title: ${chart.title}`,
        `- Labels: ${chart.data.labels.join(', ')}`,
        `- Values: ${chart.data.values.join(', ')}`,
      ]
    : ['- No chart generated: need at least one numeric column and one category/date column.'];
  return [
    `# Data analysis: ${profile.name}`,
    '',
    '## Summary',
    ...insights.map((insight) => `- ${insight}`),
    '',
    '## Columns',
    markdownTable(profile),
    '',
    '## Chart',
    ...chartLines,
    '',
  ].join('\n');
}

/**
 * @param {DataFileOptions} [options]
 * @returns {DataAnalysis}
 */
export function analyzeDataFile(options = {}) {
  const table = readDataTable(options);
  const profile = profileDataFile(options);
  const chart = buildChart(profile, table);
  const insights = buildInsights(profile, chart);
  return {
    kind: 'data-analysis',
    path: profile.path,
    name: profile.name,
    rowCount: profile.rowCount,
    columnCount: profile.columns.length,
    sampledRows: profile.sampledRows,
    truncated: profile.truncated,
    insights,
    chart,
    reportMarkdown: buildReportMarkdown(profile, chart, insights),
    profile,
  };
}
