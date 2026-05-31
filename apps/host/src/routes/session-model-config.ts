// 会话级模型配置(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:把单次请求体里携带的「会话级模型覆盖」安全叠加到基础 Kimi 配置,并判断调用方
//       是否有权使用会话级覆盖。依赖:仅第三方 schema 库,不反向依赖 L4 组装根。
import { z } from 'zod';

export type SessionModelConfig = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

type RouteError = Error & { statusCode?: number };

const sessionModelSourceSchema = z.object({
  provider: z.string().optional(),
  modelProvider: z.string().optional(),
  kimiProvider: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelApiKey: z.string().optional(),
  kimiApiKey: z.string().optional(),
}).passthrough();

const sessionModelRequestSchema = sessionModelSourceSchema.extend({
  modelConfig: sessionModelSourceSchema.optional(),
  kimiConfig: sessionModelSourceSchema.optional(),
}).passthrough();

type SessionModelSource = z.infer<typeof sessionModelSourceSchema>;

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function inputError(message: string): RouteError {
  const error = new Error(`session model config: ${message}`) as RouteError;
  error.statusCode = 400;
  return error;
}

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

function parseRequest(body: unknown): z.infer<typeof sessionModelRequestSchema> {
  const result = sessionModelRequestSchema.safeParse(objectOrEmpty(body));
  if (!result.success) {
    throw inputError(result.error.issues.map(zodIssueMessage).join('; '));
  }
  return result.data;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanProvider(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function cleanBaseUrl(value: unknown): string {
  return cleanText(value).replace(/\/+$/, '');
}

function nonEmptyObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

function requestModelConfig(body: unknown): SessionModelConfig {
  const request = parseRequest(body);
  const nested = request.modelConfig ?? request.kimiConfig;
  // modelConfig/kimiConfig 一旦出现且非空就作为唯一覆盖来源,避免顶层字段和嵌套字段混用造成歧义。
  const source: SessionModelSource = nonEmptyObject(nested) ? nested : request;
  const out: SessionModelConfig = {};
  const provider = cleanProvider(source.provider || source.modelProvider || source.kimiProvider);
  const model = cleanText(source.model);
  const baseUrl = cleanBaseUrl(source.baseUrl || source.apiBaseUrl);
  const apiKey = cleanText(source.apiKey || source.modelApiKey || source.kimiApiKey);
  if (provider) out.provider = provider;
  if (model) out.model = model;
  if (baseUrl) out.baseUrl = baseUrl;
  if (apiKey) out.apiKey = apiKey;
  return out;
}

/**
 * Builds a per-request model config without mutating or persisting the host
 * default. Only scalar model routing fields are accepted; fallback chains stay
 * host-managed so request bodies cannot smuggle secret fallback layers.
 */
export function applySessionModelConfig(kimiConfig: unknown, body: unknown): Record<string, unknown> {
  const base = { ...objectOrEmpty(kimiConfig) };
  const override = requestModelConfig(body);
  return Object.keys(override).length ? { ...base, ...override } : base;
}

export function hasSessionModelAccess(body: unknown): boolean {
  const override = requestModelConfig(body);
  if (override.apiKey) return true;
  return override.provider === 'openai/local' || override.provider === 'local-openai';
}
