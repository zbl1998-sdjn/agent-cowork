import { formatDurationMs, formatEstimatedCost, formatTokenCount } from './usage-display';
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
  const rows = (record.events || []).flatMap((event) => {
    const source = event as Record<string, unknown>;
    if (text(source.type) !== 'tool_call') return [];
    const name = text(source.name || source.tool);
    if (!name) return [];
    const reason = text(source.reason || source.why || source.rationale || source.detail || source.text) || '原因未记录';
    return [{ label: name, value: reason }];
  });
  const seen = new Set<string>();
  return rows.filter((item) => {
    const key = `${item.label}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectInitialRunId(records: Array<Pick<RunRecord, 'id'>>, currentId: string | null): string | null {
  if (currentId && records.some((record) => record.id === currentId)) return currentId;
  return records[0]?.id ?? null;
}

export function buildRunObservabilityView(record: RunRecord | null | undefined): RunObservabilityView {
  const safeRecord: RunRecord = record || { id: '', type: 'run', status: 'unknown' };
  const metrics = safeRecord.metrics || {};
  const attribution = safeRecord.attribution || {};
  const tokens = metrics.tokens || {};
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

  return {
    title,
    subtitle,
    cards: [
      {
        label: '用量',
        value: formatTokenCount(tokens.total_tokens),
        detail: `Prompt ${integerText(tokens.prompt_tokens)} / Completion ${integerText(tokens.completion_tokens)}`,
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
