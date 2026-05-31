// Kimi route input contracts(host · L3 routes)
// ---------------------------------------------------------------------------
// Keeps boundary validation close to kimi-routes while leaving route logic focused on orchestration.
import { z } from 'zod';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';
import type { ModelFallback } from '../kimi/api-runner-config.js';

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
  (min == null ? z.number().finite() : z.number().finite().min(min)).optional(),
);
const promptSchema = z.string().refine((value) => value.trim().length > 0, 'body.prompt is required');
const trustedRootSchema = optionalNonEmptyText(1000);

export const kimiFallbackSchema = z.object({
  provider: optionalText(96),
  apiKey: optionalText(4096),
  baseUrl: optionalText(2048),
  model: optionalText(200),
  timeoutMs: optionalNumber(1000),
  maxTokens: optionalNumber(1),
  temperature: optionalNumber(),
}).passthrough();

export const kimiConfigBodySchema = objectBody('invalid kimi config request').pipe(z.object({
  clearKey: z.boolean().optional(),
  apiKey: optionalText(4096),
  provider: optionalText(96),
  fallbacks: z.array(kimiFallbackSchema, 'fallbacks must be an array').optional(),
  baseUrl: optionalText(2048),
  model: optionalText(200),
}).passthrough());

export const kimiPlanChatBodySchema = objectBody('invalid kimi request').pipe(z.object({
  prompt: promptSchema,
  summary: z.unknown().optional(),
  mode: optionalText(32),
  trustedRoot: trustedRootSchema,
}).passthrough());

export const kimiAgentStreamBodySchema = objectBody('invalid agent stream request').pipe(z.object({
  prompt: z.string().optional(),
  resumeRunId: optionalNonEmptyText(96),
  trustedRoot: trustedRootSchema,
}).passthrough());

export const kimiChatStreamBodySchema = objectBody('invalid kimi stream request').pipe(z.object({
  prompt: promptSchema,
  summary: z.unknown().optional(),
  thinking: z.unknown().optional(),
  model: z.unknown().optional(),
  trustedRoot: trustedRootSchema,
}).passthrough());

export type KimiConfigBody = z.output<typeof kimiConfigBodySchema>;
export type KimiPlanChatBody = z.output<typeof kimiPlanChatBodySchema>;
export type KimiAgentStreamBody = z.output<typeof kimiAgentStreamBodySchema>;
export type KimiChatStreamBody = z.output<typeof kimiChatStreamBodySchema>;

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export function parseKimiBody<T>(
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

export function normalizeKimiFallbacks(fallbacks: KimiConfigBody['fallbacks']): ModelFallback[] {
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
