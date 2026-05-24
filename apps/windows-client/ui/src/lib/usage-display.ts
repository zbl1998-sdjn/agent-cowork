export interface UsageTransparency {
  schemaVersion?: number;
  model?: string;
  tokens?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  cost?: {
    currency?: string;
    input?: number;
    output?: number;
    total?: number;
    estimated?: boolean;
    source?: string;
  };
  duration?: {
    totalMs?: number;
    phases?: Array<{ key?: string; label?: string; durationMs?: number; percent?: number }>;
    unaccountedMs?: number;
  };
  disclosure?: {
    estimated?: boolean;
    source?: string;
    requiresSecret?: boolean;
  };
}

export interface UsageDisplayRow {
  label: string;
  value: string;
  tone: 'neutral' | 'muted';
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function formatTokenCount(value: unknown): string {
  const n = Math.max(0, Math.round(numberValue(value, 0)));
  return `${n.toLocaleString('en-US')} tokens`;
}

export function formatDurationMs(value: unknown): string {
  const ms = Math.max(0, Math.round(numberValue(value, 0)));
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatEstimatedCost(cost: UsageTransparency['cost']): string {
  const total = Math.max(0, numberValue(cost?.total, 0));
  const currency = cost?.currency || 'USD';
  const prefix = cost?.estimated === false ? '' : '≈';
  if (total === 0) return `${prefix}${currency} 0.00`;
  if (total < 0.01) return `${prefix}${currency} ${total.toFixed(5)}`;
  return `${prefix}${currency} ${total.toFixed(2)}`;
}

export function buildUsageDisplayRows(summary: UsageTransparency | null | undefined): UsageDisplayRow[] {
  if (!summary) return [];
  const tokens = summary.tokens || {};
  const rows: UsageDisplayRow[] = [
    { label: 'Tokens', value: formatTokenCount(tokens.total_tokens), tone: 'neutral' },
    { label: 'Prompt', value: formatTokenCount(tokens.prompt_tokens), tone: 'muted' },
    { label: 'Completion', value: formatTokenCount(tokens.completion_tokens), tone: 'muted' },
    { label: 'Cost', value: formatEstimatedCost(summary.cost), tone: 'neutral' },
    { label: 'Elapsed', value: formatDurationMs(summary.duration?.totalMs), tone: 'neutral' },
  ];
  for (const phase of summary.duration?.phases || []) {
    const label = phase.label || phase.key || 'Phase';
    const suffix = phase.percent !== undefined ? ` (${numberValue(phase.percent).toFixed(1)}%)` : '';
    rows.push({ label, value: `${formatDurationMs(phase.durationMs)}${suffix}`, tone: 'muted' });
  }
  if (summary.duration?.unaccountedMs) {
    rows.push({ label: 'Other', value: formatDurationMs(summary.duration.unaccountedMs), tone: 'muted' });
  }
  if (summary.disclosure?.requiresSecret === false) {
    rows.push({ label: 'Estimate', value: summary.disclosure.source || 'local-estimate', tone: 'muted' });
  }
  return rows;
}

