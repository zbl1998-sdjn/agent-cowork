// @ts-check

import { createHeuristicTokenEstimator } from './token-estimator.js';

const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_MAX_SOURCES = 16;
const DEFAULT_MAX_KEY_POINTS = 24;
const DEFAULT_PREVIEW_LINES = 8;
const KEY_POINT_RE = /\b(?:important|summary|error|failed|failure|warning|decision|fact|todo|fixme|security|risk|blocked|validate|validation|token|cost)\b|(?:重要|摘要|错误|失败|警告|决定|关键事实|风险|阻塞|安全|必须|校验|验证)/iu;
const SOURCE_KEY_RE = /(?:^|_)(?:path|file|source|url|href|uri|relativePath)$/iu;
const URL_RE = /\bhttps?:\/\/[^\s"'<>),]+/giu;
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w .()[\]-]+)+)/gu;

/**
 * @typedef {{ estimateText(value: unknown): number }} TokenEstimatorLike
 * @typedef {{ summarized: boolean, beforeTokens: number, afterTokens: number, content: string, sources: string[], keyPoints: string[] }} ShrinkResult
 */

/** @param {unknown} value @returns {string} */
function stableText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value, null, 2) || '';
  } catch {
    return String(value);
  }
}

/** @param {string} text @param {number} maxChars @returns {string} */
function clipText(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 18)).trim()} ...[truncated]`;
}

/**
 * @param {string[]} list
 * @param {string} value
 * @param {number} limit
 * @param {boolean} [priority]
 */
function pushUnique(list, value, limit, priority = false) {
  const clean = clipText(value, 240);
  if (!clean) return;
  const key = clean.toLowerCase();
  if (list.some((item) => item.toLowerCase() === key)) return;
  if (priority && list.length >= limit) {
    list.pop();
    list.unshift(clean);
    return;
  }
  if (list.length >= limit) return;
  list.push(clean);
}

/** @param {string} text @param {number} maxTokens @param {TokenEstimatorLike} estimator @returns {string} */
function clipToTokenBudget(text, maxTokens, estimator) {
  if (maxTokens <= 0) return '';
  if (estimator.estimateText(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid).trim()} ...[truncated]`;
    if (estimator.estimateText(candidate) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low).trim()} ...[truncated]`;
}

/**
 * @param {string} text
 * @param {string[]} sources
 * @param {number} limit
 */
function collectSourcesFromText(text, sources, limit) {
  for (const match of text.matchAll(URL_RE)) {
    pushUnique(sources, match[0], limit);
  }
  for (const match of text.matchAll(PATH_RE)) {
    pushUnique(sources, match[0].replace(/\\/g, '/'), limit);
  }
  const sourceLabel = text.match(/\b(?:file|source|path|url)\s*[:=]\s*([^\s,;]+)/iu);
  if (sourceLabel) {
    pushUnique(sources, sourceLabel[1].replace(/\\/g, '/'), limit);
  }
}

/**
 * @param {unknown} value
 * @param {{ sources: string[], keyPoints: string[], maxSources: number, maxKeyPoints: number, pathHint?: string, depth: number }} state
 */
function inspectValue(value, state) {
  if (value === undefined || value === null || state.depth > 8) return;
  if (typeof value === 'string') {
    collectSourcesFromText(value, state.sources, state.maxSources);
    const lines = value.split(/\r?\n/u);
    for (const line of lines) {
      if (KEY_POINT_RE.test(line)) {
        pushUnique(state.keyPoints, state.pathHint ? `${state.pathHint}: ${line}` : line, state.maxKeyPoints);
      }
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) inspectValue(item, { ...state, depth: state.depth + 1 });
    return;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const sourceValue = Object.entries(record).find(([key]) => SOURCE_KEY_RE.test(key))?.[1];
  const pathHint = typeof sourceValue === 'string'
    ? sourceValue.replace(/\\/g, '/')
    : state.pathHint;
  if (pathHint) pushUnique(state.sources, pathHint, state.maxSources);

  const line = record.line !== undefined ? `:${record.line}` : '';
  const interesting = [
    record.summary,
    record.error,
    record.message,
    record.text,
    record.content,
    record.reason,
  ].map(stableText).filter(Boolean);
  for (const item of interesting) {
    if (KEY_POINT_RE.test(item)) {
      if (pathHint) pushUnique(state.sources, pathHint, state.maxSources, true);
      pushUnique(state.keyPoints, pathHint ? `${pathHint}${line}: ${item}` : item, state.maxKeyPoints);
    }
    collectSourcesFromText(item, state.sources, state.maxSources);
  }
  for (const [key, child] of Object.entries(record)) {
    if (SOURCE_KEY_RE.test(key) && typeof child === 'string') {
      pushUnique(state.sources, child.replace(/\\/g, '/'), state.maxSources);
    }
    inspectValue(child, { ...state, pathHint, depth: state.depth + 1 });
  }
}

/**
 * @param {string} text
 * @param {number} maxLines
 * @returns {string[]}
 */
function previewLines(text, maxLines) {
  return text
    .split(/\r?\n/u)
    .map((line) => clipText(line, 180))
    .filter(Boolean)
    .slice(0, maxLines);
}

/**
 * @param {{ beforeTokens: number, sources: string[], keyPoints: string[], preview: string[] }} parts
 * @returns {string}
 */
function renderSummary(parts) {
  const keyPoints = parts.keyPoints.length ? parts.keyPoints.map((point) => `- ${point}`) : ['- none detected'];
  const sources = parts.sources.length ? parts.sources.map((source) => `- ${source}`) : ['- none detected'];
  const preview = parts.preview.length ? parts.preview.map((line) => `- ${line}`) : ['- omitted'];
  return [
    '[tool result summarized]',
    `Original estimated tokens: ${parts.beforeTokens}`,
    'Key points:',
    ...keyPoints,
    'Sources:',
    ...sources,
    'Preview:',
    ...preview,
  ].join('\n');
}

export class ToolResultSummarizer {
  /**
   * @param {{ estimator?: TokenEstimatorLike, maxTokens?: number, maxSources?: number, maxKeyPoints?: number, previewLines?: number }} [options]
   */
  constructor(options = {}) {
    this.estimator = options.estimator || createHeuristicTokenEstimator();
    this.maxTokens = Math.max(1, Math.round(Number(options.maxTokens) || DEFAULT_MAX_TOKENS));
    this.maxSources = Math.max(1, Math.round(Number(options.maxSources) || DEFAULT_MAX_SOURCES));
    this.maxKeyPoints = Math.max(1, Math.round(Number(options.maxKeyPoints) || DEFAULT_MAX_KEY_POINTS));
    this.previewLines = Math.max(0, Math.round(Number(options.previewLines) || DEFAULT_PREVIEW_LINES));
  }

  /**
   * @param {unknown} result
   * @param {{ maxTokens?: number, maxSources?: number, maxKeyPoints?: number }} [options]
   * @returns {ShrinkResult}
   */
  shrink(result, options = {}) {
    const maxTokens = Math.max(1, Math.round(Number(options.maxTokens) || this.maxTokens));
    const maxSources = Math.max(1, Math.round(Number(options.maxSources) || this.maxSources));
    const maxKeyPoints = Math.max(1, Math.round(Number(options.maxKeyPoints) || this.maxKeyPoints));
    const content = stableText(result);
    const beforeTokens = this.estimator.estimateText(content);
    /** @type {string[]} */
    const sources = [];
    /** @type {string[]} */
    const keyPoints = [];
    inspectValue(result, { sources, keyPoints, maxSources, maxKeyPoints, depth: 0 });

    if (beforeTokens <= maxTokens) {
      return { summarized: false, beforeTokens, afterTokens: beforeTokens, content, sources, keyPoints };
    }

    let summary = renderSummary({
      beforeTokens,
      sources,
      keyPoints,
      preview: previewLines(content, this.previewLines),
    });
    let afterTokens = this.estimator.estimateText(summary);
    if (afterTokens > maxTokens) {
      summary = renderSummary({ beforeTokens, sources, keyPoints, preview: [] });
      afterTokens = this.estimator.estimateText(summary);
    }
    if (afterTokens > maxTokens && keyPoints.length > 1) {
      summary = renderSummary({ beforeTokens, sources, keyPoints: keyPoints.slice(0, 1), preview: [] });
      afterTokens = this.estimator.estimateText(summary);
    }
    if (afterTokens > maxTokens) {
      summary = clipToTokenBudget(summary, maxTokens, this.estimator);
      afterTokens = this.estimator.estimateText(summary);
    }
    return { summarized: true, beforeTokens, afterTokens, content: summary, sources, keyPoints };
  }
}

/**
 * @param {{ estimator?: TokenEstimatorLike, maxTokens?: number, maxSources?: number, maxKeyPoints?: number, previewLines?: number }} [options]
 * @returns {ToolResultSummarizer}
 */
export function createToolResultSummarizer(options = {}) {
  return new ToolResultSummarizer(options);
}
