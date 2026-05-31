// 工具结果摘要器(host · L1 领域层 · kimi/context)
// ---------------------------------------------------------------------------
// 职责:超过 token 预算时,把冗长工具结果递归抽取为「关键点 + 来源(路径/URL)
//       + 预览」的精简摘要,并按预算逐级降级;未超预算则原样返回。
// 依赖:同层 token-estimator;其余仅标准库。
// 导出:ToolResultSummarizer(类)、createToolResultSummarizer(工厂)。

import { createHeuristicTokenEstimator } from './token-estimator.js';

const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_MAX_SOURCES = 16;
const DEFAULT_MAX_KEY_POINTS = 24;
const DEFAULT_PREVIEW_LINES = 8;
const KEY_POINT_RE = /\b(?:important|summary|error|failed|failure|warning|decision|fact|todo|fixme|security|risk|blocked|validate|validation|token|cost)\b|(?:重要|摘要|错误|失败|警告|决定|关键事实|风险|阻塞|安全|必须|校验|验证)/iu;
const SOURCE_KEY_RE = /(?:^|_)(?:path|file|source|url|href|uri|relativePath)$/iu;
const URL_RE = /\bhttps?:\/\/[^\s"'<>),]+/giu;
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'<>|]+|(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w .()[\]-]+)+)/gu;

type TokenEstimatorLike = { estimateText(value: unknown): number };

export type ShrinkResult = {
  summarized: boolean;
  beforeTokens: number;
  afterTokens: number;
  content: string;
  sources: string[];
  keyPoints: string[];
};

type ToolResultSummarizerOptions = {
  estimator?: TokenEstimatorLike;
  maxTokens?: number;
  maxSources?: number;
  maxKeyPoints?: number;
  previewLines?: number;
};

type ShrinkOptions = Pick<ToolResultSummarizerOptions, 'maxTokens' | 'maxSources' | 'maxKeyPoints'>;

type InspectState = {
  sources: string[];
  keyPoints: string[];
  maxSources: number;
  maxKeyPoints: number;
  pathHint?: string;
  depth: number;
};

type RenderSummaryParts = Pick<ShrinkResult, 'beforeTokens' | 'sources' | 'keyPoints'> & {
  preview: string[];
};

function stableText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value, null, 2) || '';
  } catch {
    return String(value);
  }
}

function clipText(text: string, maxChars: number): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 18)).trim()} ...[truncated]`;
}

function pushUnique(list: string[], value: string, limit: number, priority = false): void {
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

function clipToTokenBudget(text: string, maxTokens: number, estimator: TokenEstimatorLike): string {
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

function collectSourcesFromText(text: string, sources: string[], limit: number): void {
  for (const match of text.matchAll(URL_RE)) {
    pushUnique(sources, match[0], limit);
  }
  for (const match of text.matchAll(PATH_RE)) {
    pushUnique(sources, match[0].replace(/\\/g, '/'), limit);
  }
  const sourceLabel = text.match(/\b(?:file|source|path|url)\s*[:=]\s*([^\s,;]+)/iu);
  if (sourceLabel?.[1]) {
    pushUnique(sources, sourceLabel[1].replace(/\\/g, '/'), limit);
  }
}

/**
 * 递归遍历任意结构,沿途收集来源与关键点(限深 8 层防爆栈/循环)。
 */
function inspectValue(value: unknown, state: InspectState): void {
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
    for (const item of value) {
      inspectValue(item, { ...state, depth: state.depth + 1 });
    }
    return;
  }
  const record = value as Record<string, unknown>;
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

function previewLines(text: string, maxLines: number): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => clipText(line, 180))
    .filter(Boolean)
    .slice(0, maxLines);
}

function renderSummary(parts: RenderSummaryParts): string {
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
  estimator: TokenEstimatorLike;
  maxTokens: number;
  maxSources: number;
  maxKeyPoints: number;
  previewLines: number;

  constructor(options: ToolResultSummarizerOptions = {}) {
    this.estimator = options.estimator || createHeuristicTokenEstimator();
    this.maxTokens = Math.max(1, Math.round(Number(options.maxTokens) || DEFAULT_MAX_TOKENS));
    this.maxSources = Math.max(1, Math.round(Number(options.maxSources) || DEFAULT_MAX_SOURCES));
    this.maxKeyPoints = Math.max(1, Math.round(Number(options.maxKeyPoints) || DEFAULT_MAX_KEY_POINTS));
    this.previewLines = Math.max(0, Math.round(Number(options.previewLines) || DEFAULT_PREVIEW_LINES));
  }

  /**
   * 把工具结果收缩到 token 预算内:未超则原样返回,超则生成并逐级降级摘要。
   */
  shrink(result: unknown, options: ShrinkOptions = {}): ShrinkResult {
    const maxTokens = Math.max(1, Math.round(Number(options.maxTokens) || this.maxTokens));
    const maxSources = Math.max(1, Math.round(Number(options.maxSources) || this.maxSources));
    const maxKeyPoints = Math.max(1, Math.round(Number(options.maxKeyPoints) || this.maxKeyPoints));
    const content = stableText(result);
    const beforeTokens = this.estimator.estimateText(content);
    const sources: string[] = [];
    const keyPoints: string[] = [];
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

/** 创建 ToolResultSummarizer 实例的工厂。 */
export function createToolResultSummarizer(options: ToolResultSummarizerOptions = {}): ToolResultSummarizer {
  return new ToolResultSummarizer(options);
}
