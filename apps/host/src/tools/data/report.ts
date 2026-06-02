// 数据分析报告(host · L1 领域层 · tools/data)
// ---------------------------------------------------------------------------
// 职责:在 profile 的基础上,挑选最合适的图表(柱/折线)、提炼洞察、产出 Markdown 报告草稿。
//       是数据分析闭环 profile → 图表 → 报告 的「报告」一环。纯函数、确定性。
// 依赖:同目录 profile(剖析 + 读表)。导出:analyzeDataFile。

import { profileDataFile, readDataTable, type DataColumnProfile, type DataFileOptions, type DataProfile, type DataTable } from './profile.js';

const MAX_CHART_POINTS = 12;

export type DataChart = {
  kind: 'bar' | 'line';
  title: string;
  data: { labels: string[]; values: number[]; label: string };
};
export type DataAnalysis = {
  kind: 'data-analysis';
  path: string;
  name: string;
  rowCount: number;
  columnCount: number;
  sampledRows: number;
  truncated: boolean;
  insights: string[];
  chart: DataChart | null;
  reportMarkdown: string;
  profile: DataProfile;
};

/**
 */
function numberValue(value: unknown): number | null {
  if (value === '') return null;
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 */
function columnIndex(headers: string[], name: string): number {
  return headers.findIndex((header) => String(header).trim() === String(name).trim());
}

/**
 */
function firstNumericColumn(profile: DataProfile): DataColumnProfile | null {
  return profile.columns.find((column) => column.type === 'number') || null;
}

/**
 */
function firstCategoryColumn(profile: DataProfile): DataColumnProfile | null {
  return profile.columns.find((column) => column.type === 'text' && column.unique > 1 && column.unique <= 50) || null;
}

/**
 */
function buildBarChart(profile: DataProfile, table: DataTable): DataChart | null {
  const category = firstCategoryColumn(profile);
  const numeric = firstNumericColumn(profile);
  if (!category || !numeric) return null;
  const categoryIdx = columnIndex(table.headers, category.name);
  const numericIdx = columnIndex(table.headers, numeric.name);
  if (categoryIdx < 0 || numericIdx < 0) return null;

  const totals = new Map<string, number>();
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
 */
function buildLineChart(profile: DataProfile, table: DataTable): DataChart | null {
  const date = profile.columns.find((column) => column.type === 'date');
  const numeric = firstNumericColumn(profile);
  if (!date || !numeric) return null;
  const dateIdx = columnIndex(table.headers, date.name);
  const numericIdx = columnIndex(table.headers, numeric.name);
  if (dateIdx < 0 || numericIdx < 0) return null;
  const points: Array<{ label: string; value: number }> = [];
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
 * 按 profile 的首选建议选图:倾向折线则先折线后柱状,否则反之(任一不可行回退另一种)。
 */
function buildChart(profile: DataProfile, table: DataTable): DataChart | null {
  const preferred = profile.chartSuggestions[0]?.type;
  if (preferred === 'line') return buildLineChart(profile, table) || buildBarChart(profile, table);
  return buildBarChart(profile, table) || buildLineChart(profile, table);
}

/**
 */
function buildInsights(profile: DataProfile, chart: DataChart | null): string[] {
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
 */
function markdownTable(profile: DataProfile): string {
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
 */
function buildReportMarkdown(profile: DataProfile, chart: DataChart | null, insights: string[]): string {
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
 * 分析数据文件:读表 + 剖析 → 选图 → 出洞察 → 拼 Markdown 报告,返回完整 data-analysis 结果。
 */
export function analyzeDataFile(options: DataFileOptions = {}): DataAnalysis {
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
