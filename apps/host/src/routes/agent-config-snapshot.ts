// Agent 配置快照(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:把一次 Agent 运行的「生效配置」归一化成快照,随 run 记录留存,便于回放/审计。
// 依赖:仅 zod schema 归一化。导出:buildAgentConfigSnapshot。
import { z } from 'zod';

export type FallbackConfigSnapshot = {
  provider: unknown;
  baseUrl: unknown;
  model: unknown;
  hasKey: boolean;
};

export type AgentConfigSnapshot = {
  provider: unknown;
  baseUrl: unknown;
  model: unknown;
  timeoutMs: unknown;
  maxTokens: unknown;
  temperature: number | undefined;
  fallbacks: FallbackConfigSnapshot[];
  planMode: boolean;
  developerMode: boolean;
  verify: boolean;
  maxSteps: number;
};

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const fallbackConfigSchema = z.preprocess(
  objectOrEmpty,
  z.object({
    provider: z.unknown().optional(),
    baseUrl: z.unknown().optional(),
    model: z.unknown().optional(),
    apiKey: z.unknown().optional(),
  }).passthrough(),
);

const modelConfigSnapshotSchema = z.preprocess(
  objectOrEmpty,
  z.object({
    provider: z.unknown().optional(),
    baseUrl: z.unknown().optional(),
    model: z.unknown().optional(),
    timeoutMs: z.unknown().optional(),
    maxTokens: z.unknown().optional(),
    temperature: z.unknown().optional(),
    fallbacks: z.preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(fallbackConfigSchema),
    ).optional(),
  }).passthrough(),
);

const requestSnapshotSchema = z.preprocess(
  objectOrEmpty,
  z.object({
    planMode: z.unknown().optional(),
    developerMode: z.unknown().optional(),
    mode: z.unknown().optional(),
    verify: z.unknown().optional(),
    thinking: z.unknown().optional(),
    maxSteps: z.unknown().optional(),
  }).passthrough(),
);

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function fallbackSummaries(value: unknown): FallbackConfigSnapshot[] {
  const result = z.array(fallbackConfigSchema).safeParse(Array.isArray(value) ? value : []);
  const fallbacks = result.success ? result.data : [];
  return fallbacks.map((source) => ({
    provider: source.provider,
    baseUrl: source.baseUrl,
    model: source.model,
    hasKey: Boolean(source.apiKey),
  }));
}

function parseSnapshotRequest(body: unknown): z.infer<typeof requestSnapshotSchema> {
  const result = requestSnapshotSchema.safeParse(body);
  return result.success ? result.data : {};
}

function parseSnapshotConfig(kimiConfig: unknown): z.infer<typeof modelConfigSnapshotSchema> {
  const result = modelConfigSnapshotSchema.safeParse(kimiConfig);
  return result.success ? result.data : {};
}

export function buildAgentConfigSnapshot(body: unknown, kimiConfig: unknown): AgentConfigSnapshot {
  const requestBody = parseSnapshotRequest(body);
  const config = parseSnapshotConfig(kimiConfig);
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    temperature: finiteNumber(config.temperature),
    fallbacks: fallbackSummaries(config.fallbacks),
    planMode: requestBody.planMode === true,
    developerMode: requestBody.developerMode === true || requestBody.mode === 'developer',
    verify: requestBody.verify === true || requestBody.thinking === 'deep',
    maxSteps: Math.min(Math.max(Number(requestBody.maxSteps) || 8, 1), 16),
  };
}
