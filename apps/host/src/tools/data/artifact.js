// @ts-check

import { buildLiveArtifact } from '../../artifacts/live-artifact.js';
import { analyzeDataFile } from './report.js';

/**
 * @typedef {import('./profile.js').DataFileOptions & { id?: string, title?: string }} DataChartArtifactOptions
 * @typedef {{
 *   kind: 'data-chart-artifact',
 *   source: { path: string, name: string, rowCount: number, columnCount: number, sampledRows: number, truncated: boolean },
 *   chart: { kind: string, title: string, data: { labels: string[], values: number[], label: string } },
 *   artifact: { id: string, relativePath: string, dataUrl: string, viewUrl: string },
 *   reportMarkdown: string
 * }} DataChartArtifact
 */

/**
 * @param {string} message
 * @param {number} [statusCode]
 * @returns {Error & { statusCode: number }}
 */
function fail(message, statusCode = 400) {
  const error = /** @type {Error & { statusCode: number }} */ (new Error(`data artifact: ${message}`));
  error.statusCode = statusCode;
  return error;
}

/** @param {unknown} value */
function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {DataChartArtifactOptions} [options]
 * @returns {DataChartArtifact}
 */
export function createDataChartArtifact(options = {}) {
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
    chart: analysis.chart,
    artifact: {
      id: artifact.id,
      relativePath: artifact.relativePath,
      dataUrl: artifact.dataUrl,
      viewUrl: `/api/artifacts/live/${artifact.id}`,
    },
    reportMarkdown: analysis.reportMarkdown,
  };
}
