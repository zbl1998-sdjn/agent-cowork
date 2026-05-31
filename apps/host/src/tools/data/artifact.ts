// 数据图表制品(host · L1 领域层 · tools/data)
// ---------------------------------------------------------------------------
// 职责:分析数据文件并把推荐图表落成「活页 artifact」(写操作)。串起 data 分析与 artifacts 制品。
// 依赖:artifacts/live-artifact(落盘) + 同目录 report(分析)。导出:createDataChartArtifact。

import { buildLiveArtifact } from '../../artifacts/live-artifact.js';
import { analyzeDataFile } from './report.js';

export type DataChartArtifactOptions = {
  trustedRoot?: string;
  path?: string;
  maxBytes?: number;
  maxRows?: number;
  id?: string;
  title?: string;
};
export type DataChartSpec = {
  kind: string;
  title: string;
  data: { labels: string[]; values: number[]; label: string };
};
export type DataChartArtifact = {
  kind: 'data-chart-artifact';
  source: { path: string; name: string; rowCount: number; columnCount: number; sampledRows: number; truncated: boolean };
  chart: DataChartSpec;
  artifact: { id: string; relativePath: string; dataUrl: string; viewUrl: string };
  reportMarkdown: string;
};

function fail(message: string, statusCode = 400): Error & { statusCode: number } {
  const error = new Error(`data artifact: ${message}`) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 分析数据文件 → 取推荐图表 → 构建活页 artifact 落盘,返回含源信息/图表/制品引用/报告的结果。
 */
export function createDataChartArtifact(options: DataChartArtifactOptions = {}): DataChartArtifact {
  const trustedRoot = cleanText(options.trustedRoot);
  if (!trustedRoot) {
    throw fail('trustedRoot is required');
  }
  const analysis = analyzeDataFile({ ...options, trustedRoot });
  if (!analysis.chart) {
    throw fail('no chart can be generated for this data file');
  }
  const title = cleanText(options.title) || analysis.chart.title || `Data chart: ${analysis.name}`;
  const viz = {
    kind: analysis.chart.kind,
    title,
    data: analysis.chart.data,
    options: { responsive: true },
  };
  const artifact = buildLiveArtifact({
    trustedRoot,
    id: cleanText(options.id) || undefined,
    title,
    viz,
  });
  return {
    kind: 'data-chart-artifact',
    source: {
      path: analysis.path,
      name: analysis.name,
      rowCount: analysis.rowCount,
      columnCount: analysis.columnCount,
      sampledRows: analysis.sampledRows,
      truncated: analysis.truncated,
    },
    chart: analysis.chart as DataChartSpec,
    artifact: {
      id: artifact.id,
      relativePath: artifact.relativePath,
      dataUrl: artifact.dataUrl,
      viewUrl: `/api/artifacts/live/${artifact.id}`,
    },
    reportMarkdown: analysis.reportMarkdown,
  };
}
