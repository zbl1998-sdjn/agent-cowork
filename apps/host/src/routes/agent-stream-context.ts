// Agent 上下文压缩配置解析(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:把 /api/agent/chat/stream 请求体中的 UI 开关/预算字段解析成 tool-loop 的 contextOptions。
import { omitUndefined } from '../util/object.js';

type NumericLimit = number | string;

type ContextCompactionConfig = {
  enabled?: boolean;
  maxContextTokens?: NumericLimit;
  keepRecentMessages?: NumericLimit;
  maxFacts?: NumericLimit;
};

type AgentContextRequestBody = {
  contextCompaction?: ContextCompactionConfig;
  autoCompactContext?: boolean;
  maxContextTokens?: NumericLimit;
  keepRecentMessages?: NumericLimit;
  maxContextFacts?: NumericLimit;
};

export type AgentContextOptions = {
  maxContextTokens?: number;
  keepRecentMessages?: number;
  maxFacts?: number;
};

const DISABLED_MAX_CONTEXT_TOKENS = 1_000_000_000;

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInt(value: unknown, min: number, max: number): number | undefined {
  if (value == null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  const rounded = Math.round(num);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function resolveAgentContextOptions(body: unknown): AgentContextOptions {
  const raw = objectOrEmpty(body) as AgentContextRequestBody;
  const nested = objectOrEmpty(raw.contextCompaction) as ContextCompactionConfig;
  const enabled = nested.enabled !== false && raw.autoCompactContext !== false;
  if (!enabled) return { maxContextTokens: DISABLED_MAX_CONTEXT_TOKENS };
  return omitUndefined({
    maxContextTokens: positiveInt(nested.maxContextTokens ?? raw.maxContextTokens, 256, 1_000_000),
    keepRecentMessages: positiveInt(nested.keepRecentMessages ?? raw.keepRecentMessages, 1, 100),
    maxFacts: positiveInt(nested.maxFacts ?? raw.maxContextFacts, 1, 200),
  });
}
