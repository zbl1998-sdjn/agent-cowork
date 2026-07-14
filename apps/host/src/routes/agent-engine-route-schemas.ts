// Kimi 路由入参契约与解析(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:用 zod 定义 /api/agent-engine/* 各请求体的边界校验 schema(配置、计划对话、Agent 流、
// 聊天流),并提供统一的请求体解析(校验失败回 400)与 fallbacks 归一化辅助,
// 让 agent-engine-routes 专注编排、把边界校验留在此处。
// 依赖:L0 http(request-utils.sendJson),L1 engine(api-runner-config 的 ModelFallback 类型),zod。
// 导出:modelFallbackSchema、agentEngineConfigBodySchema、agentEnginePlanChatBodySchema、agentEngineStreamBodySchema、
//       agentEngineChatStreamBodySchema、对应的 Body 类型、parseAgentEngineBody、normalizeModelFallbacks。
import { z } from 'zod';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';
import type { ModelFallback } from '../engine/api-runner-config.js';

const objectBody = (message: string): z.ZodType<Record<string, unknown>> => z.custom<Record<string, unknown>>(
  (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)),
  { message },
);

const optionalText = (max: number) => z.preprocess(
  (value) => (value == null ? undefined : value),
  z.string().trim().max(max).optional(),
);
const optionalNonEmptyText = (max: number) => z.preprocess(
  (value) => (value == null || value === '' ? undefined : value),
  z.string().trim().min(1).max(max).optional(),
);
const optionalNumber = (min?: number) => z.preprocess(
  (value) => (value == null || value === '' ? undefined : Number(value)),
  (min == null ? z.number() : z.number().min(min)).optional(),
);
const promptSchema = z.string().refine((value) => value.trim().length > 0, 'body.prompt is required');
const trustedRootSchema = optionalNonEmptyText(1000);

export const modelFallbackSchema = z.object({
  provider: optionalText(96),
  apiKey: optionalText(4096),
  baseUrl: optionalText(2048),
  model: optionalText(200),
  timeoutMs: optionalNumber(1000),
  maxTokens: optionalNumber(1),
  temperature: optionalNumber(),
}).loose();

export const agentEngineConfigBodySchema = objectBody('invalid kimi config request').pipe(z.object({
  clearKey: z.boolean().optional(),
  apiKey: optionalText(4096),
  provider: optionalText(96),
  fallbacks: z.array(modelFallbackSchema, 'fallbacks must be an array').optional(),
  baseUrl: optionalText(2048),
  model: optionalText(200),
}).loose());

export const agentEngineTestBodySchema = objectBody('invalid kimi test request').pipe(z.object({
  action: z.literal('models').default('models'),
  apiKey: optionalText(4096),
  provider: optionalText(96),
  baseUrl: optionalText(2048),
  model: optionalText(200),
}).loose());

export const agentEnginePlanChatBodySchema = objectBody('invalid kimi request').pipe(z.object({
  prompt: promptSchema,
  summary: z.unknown().optional(),
  mode: optionalText(32),
  trustedRoot: trustedRootSchema,
}).loose());

export const agentEngineStreamBodySchema = objectBody('invalid agent stream request').pipe(z.object({
  prompt: z.string().optional(),
  resumeRunId: optionalNonEmptyText(96),
  trustedRoot: trustedRootSchema,
  templateFiles: z.array(z.string().trim().min(1).max(2000)).max(4).optional(),
}).loose());

export const agentEngineChatStreamBodySchema = objectBody('invalid kimi stream request').pipe(z.object({
  prompt: promptSchema,
  summary: z.unknown().optional(),
  thinking: z.unknown().optional(),
  model: z.unknown().optional(),
  trustedRoot: trustedRootSchema,
}).loose());

export type AgentEngineConfigBody = z.output<typeof agentEngineConfigBodySchema>;
export type AgentEngineTestBody = z.output<typeof agentEngineTestBodySchema>;
export type AgentEnginePlanChatBody = z.output<typeof agentEnginePlanChatBodySchema>;
export type AgentEngineStreamBody = z.output<typeof agentEngineStreamBodySchema>;
export type AgentEngineChatStreamBody = z.output<typeof agentEngineChatStreamBodySchema>;

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

/** 用给定 schema 解析请求体;校验失败时直接回 400 并返回 null。 */
export function parseAgentEngineBody<T>(
  response: HttpResponseLike,
  schema: z.ZodType<T>,
  body: unknown,
  fallback: string,
): T | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, fallback) });
    return null;
  }
  return parsed.data;
}

/** 清洗并裁剪 fallback 列表(去空白、夹紧下限),滤掉无任何有效字段的项。 */
export function normalizeModelFallbacks(fallbacks: AgentEngineConfigBody['fallbacks']): ModelFallback[] {
  return (fallbacks || []).map((fallback) => ({
    ...(fallback.provider ? { provider: fallback.provider.trim().toLowerCase() } : {}),
    ...(fallback.apiKey ? { apiKey: fallback.apiKey.trim() } : {}),
    ...(fallback.baseUrl ? { baseUrl: fallback.baseUrl.trim().replace(/\/+$/, '') } : {}),
    ...(fallback.model ? { model: fallback.model.trim() } : {}),
    ...(fallback.timeoutMs != null ? { timeoutMs: Math.max(1000, fallback.timeoutMs) } : {}),
    ...(fallback.maxTokens != null ? { maxTokens: Math.max(1, fallback.maxTokens) } : {}),
    ...(fallback.temperature != null ? { temperature: fallback.temperature } : {}),
  })).filter((fallback) => (
    fallback.provider || fallback.apiKey || fallback.baseUrl || fallback.model
  ));
}
