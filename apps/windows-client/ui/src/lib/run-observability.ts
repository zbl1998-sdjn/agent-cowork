// 运行可观测整形(UI · 逻辑层 · lib)
// ---------------------------------------------------------------------------
// 职责:把一条运行记录(用量/成本/工具调用/失败率/耗时/归因/来源)整形成面板可直接渲染的
// 视图模型(卡片+多组行),并选定初始运行 id。依赖:lib/usage-display、lib/observability-args、lib/types。
// 导出:selectInitialRunId、buildRunObservabilityView 及 RunObservabilityView 等类型。
import { formatDurationMs, formatEstimatedCost, formatTokenCount } from './usage-display';
import { summariseArgs } from './observability-args';
import type { RunRecord, SourceRef } from './types';

export type ObservabilityTone = 'neutral' | 'warn' | 'danger';

export interface ObservabilityCard {
  label: string;
  value: string;
  detail: string;
  tone: ObservabilityTone;
}

export interface ObservabilityRow {
  label: string;
  value: string;
  path?: string;
}

export interface RunObservabilityView {
  title: string;
  subtitle: string;
  cards: ObservabilityCard[];
  toolNames: string[];
  toolReasonRows: ObservabilityRow[];
  timingRows: ObservabilityRow[];
  attributionRows: ObservabilityRow[];
  configRows: ObservabilityRow[];
  sourceRows: ObservabilityRow[];
  isSparse: boolean;
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function integerText(value: unknown): string {
  return Math.max(0, Math.round(numberValue(value, 0))).toLocaleString('en-US');
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function row(label: string, value: unknown): ObservabilityRow | null {
  const display = text(value);
  return display ? { label, value: display } : null;
}

function compactRows(rows: Array<ObservabilityRow | null>): ObservabilityRow[] {
  return rows.filter((item): item is ObservabilityRow => Boolean(item));
}

function configValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sourceLabel(source: SourceRef): string {
  return source.relativePath || source.path;
}

function sourceValue(source: SourceRef): string {
  const start = source.startLine;
  const end = source.endLine;
  if (typeof start === 'number' && typeof end === 'number' && end !== start) return `L${start}-L${end}`;
  if (typeof start === 'number') return `L${start}`;
  return '打开来源';
}

function sourceRefsFromRecord(record: RunRecord): SourceRef[] {
  const direct = Array.isArray(record.sources) ? record.sources : [];
  const fromEvents = (record.events || []).flatMap((event) => {
    const items = (event as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is SourceRef => {
      return Boolean(item && typeof item === 'object' && typeof (item as SourceRef).path === 'string');
    });
  });
  const seen = new Set<string>();
  return direct.concat(fromEvents).filter((source) => {
    const key = `${source.path}:${source.startLine ?? ''}:${source.endLine ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toolReasonRowsFromRecord(record: RunRecord): ObservabilityRow[] {
  const rows: ObservabilityRow[] = [];
  for (const event of (record.events || [])) {
    const source = event as Record<string, unknown>;
    // agent-stream 当前事件形状为 { type:'tool_call', name, args };没有显式 reason 时,
    // 用参数摘要兜底,至少让用户知道调用了什么,而不是只看到"原因未记录"。
    if (text(source.type) === 'tool_call') {
      const name = text(source.name || source.tool);
      if (!name) continue;
      const explicitReason = text(source.reason || source.why || source.rationale || source.detail || source.text);
      const argsSummary = summariseArgs(source.args);
      const reason = explicitReason || argsSummary || '(无参数)';
      rows.push({ label: name, value: reason });
      continue;
    }
    // RunTrace 当前形状为 { kind:'tool_decision', step, modelMessage:{ content, tool_calls:[...] } };
    // 工具调用前的助手文本(modelMessage.content)就是原因,每个工具调用单独出一行便于按工具名分组。
    if (text(source.kind) === 'tool_decision') {
      const modelMessage = source.modelMessage as Record<string, unknown> | null | undefined;
      if (!modelMessage || typeof modelMessage !== 'object') continue;
      const reason = text(modelMessage.content) || '(无推理文本)';
      const calls = Array.isArray(modelMessage.tool_calls) ? (modelMessage.tool_calls as unknown[]) : [];
      for (const call of calls) {
        const fn = (call as { function?: { name?: unknown } } | null | undefined)?.function;
        const name = text(fn?.name);
        if (!name) continue;
        rows.push({ label: name, value: reason });
      }
    }
  }
  const seen = new Set<string>();
  return rows.filter((item) => {
    const key = `${item.label}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// token 优先取 metrics.tokens;若 host 只记录了 Agent 结果,则兼容读取 result.usage
// (OpenAI 兼容字段 prompt_tokens/completion_tokens/total_tokens),避免用量卡片空白。
function resolveTokensFromRecord(record: RunRecord): Record<string, unknown> {
  const metrics = (record.metrics || {}) as Record<string, unknown>;
  const fromMetrics = metrics.tokens as Record<string, unknown> | undefined;
  if (fromMetrics && typeof fromMetrics === 'object') return fromMetrics;
  const result = (record as unknown as Record<string, unknown>).result;
  if (result && typeof result === 'object') {
    const usage = (result as Record<string, unknown>).usage;
    if (usage && typeof usage === 'object') return usage as Record<string, unknown>;
  }
  return {};
}

export function selectInitialRunId(records: Array<Pick<RunRecord, 'id'>>, currentId: string | null): string | null {
  if (currentId && records.some((record) => record.id === currentId)) return currentId;
  return records[0]?.id ?? null;
}

export function buildRunObservabilityView(record: RunRecord | null | undefined): RunObservabilityView {
  const safeRecord: RunRecord = record || { id: '', type: 'run', status: 'unknown' };
  const metrics = safeRecord.metrics || {};
  const attribution = safeRecord.attribution || {};
  const tokens = resolveTokensFromRecord(safeRecord);
  const cost = metrics.cost;
  const tools = metrics.tools || {};
  const failures = metrics.failures || {};
  const steps = metrics.steps || {};
  const title = text(safeRecord.promptPreview) || text(safeRecord.input?.prompt) || text(safeRecord.prompt) || text(safeRecord.id) || '未选择运行';
  const subtitle = [safeRecord.type || 'run', safeRecord.status || 'unknown', safeRecord.id].filter(Boolean).join(' · ');
  const providerName = text(metrics.provider) || text(cost?.provider) || text(attribution.model?.provider) || text(safeRecord.provider) || '未记录';
  const modelName = text(metrics.model) || text(attribution.model?.model) || text(safeRecord.provider) || '未记录';
  const modelDetail = [providerName, attribution.model?.mode].map(text).filter(Boolean).join(' / ') || '无归因';
  const toolFailures = numberValue(tools.failed, 0);
  const toolCalls = numberValue(tools.calls, 0);
  const failureRate = numberValue(failures.rate, 0);
  const runFailed = Boolean(failures.runFailed);
  const failureTone: ObservabilityTone = runFailed || failureRate >= 0.2 ? 'danger' : failureRate > 0 ? 'warn' : 'neutral';
  const toolTone: ObservabilityTone = toolFailures > 0 ? 'warn' : 'neutral';
  // 前缀缓存命中:cached_tokens(Kimi/OpenAI)或 prompt_cache_hit_tokens(DeepSeek)占输入 token 的比例。
  // 仅在确有命中时追加到用量卡详情,避免在无缓存数据的旧记录上改变既有展示。
  const cachedTokens = numberValue(tokens.cached_tokens ?? tokens.prompt_cache_hit_tokens, 0);
  const promptTokensForCache = numberValue(tokens.prompt_tokens, 0);
  const cacheHitPct = promptTokensForCache > 0 ? (cachedTokens / promptTokensForCache) * 100 : 0;
  const usageDetail = `Prompt ${integerText(tokens.prompt_tokens)} / Completion ${integerText(tokens.completion_tokens)}`
    + (cachedTokens > 0 ? ` · 缓存命中 ${integerText(cachedTokens)} (${cacheHitPct.toFixed(0)}%)` : '');

  return {
    title,
    subtitle,
    cards: [
      {
        label: '用量',
        value: formatTokenCount(tokens.total_tokens),
        detail: usageDetail,
        tone: 'neutral',
      },
      {
        label: '估算成本',
        value: formatEstimatedCost(cost),
        detail: `${providerName} · ${cost?.source || (cost?.estimated === false ? 'metered' : 'local-estimate')}`,
        tone: 'neutral',
      },
      {
        label: '工具调用',
        value: `${integerText(toolCalls)} 次`,
        detail: `${integerText(tools.succeeded)} 成功 / ${integerText(toolFailures)} 失败`,
        tone: toolTone,
      },
      {
        label: '失败率',
        value: `${(failureRate * 100).toFixed(1)}%`,
        detail: runFailed ? '运行失败' : `${integerText(failures.count)} 个失败`,
        tone: failureTone,
      },
      {
        label: '模型',
        value: modelName,
        detail: modelDetail,
        tone: 'neutral',
      },
    ],
    toolNames: Array.isArray(tools.unique) ? tools.unique.filter(Boolean) : [],
    toolReasonRows: toolReasonRowsFromRecord(safeRecord),
    timingRows: compactRows([
      row('总耗时', formatDurationMs(metrics.duration?.totalMs ?? safeRecord.durationMs)),
      row('步骤', `${integerText(steps.total)} 总 / ${integerText(steps.succeeded)} 成功 / ${integerText(steps.failed)} 失败`),
      row('未归因耗时', metrics.duration?.unaccountedMs ? formatDurationMs(metrics.duration.unaccountedMs) : ''),
    ]),
    attributionRows: compactRows([
      row('Provider', providerName),
      row('System prompt', attribution.prompt?.systemPromptVersion),
      row('Prompt builder', attribution.prompt?.builder),
      row('Prompt chars', attribution.prompt?.inputChars),
      row('Prompt hash', attribution.prompt?.inputSha256),
      row('Base URL', attribution.model?.baseUrl),
    ]),
    configRows: Object.entries(attribution.config || {})
      .slice(0, 8)
      .map(([label, value]) => ({ label, value: configValue(value) }))
      .filter((item) => item.value),
    sourceRows: sourceRefsFromRecord(safeRecord)
      .slice(0, 10)
      .map((source) => ({ label: sourceLabel(source), value: sourceValue(source), path: source.path })),
    isSparse: !safeRecord.metrics && !safeRecord.attribution,
  };
}
