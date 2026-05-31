// 工具路由输入协议(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中校验 /api/tools/* 与 /api/subagent/* 的查询参数和 JSON body。
import { z } from 'zod';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const objectBodySchema = z.preprocess(objectBody, z.object({}).passthrough());
const limitSchema = z.preprocess(
  (value) => (value == null || value === '' ? undefined : Number(value)),
  z.number().int().min(1).max(50).default(10),
);
const optionalTrustedRootSchema = z.unknown().optional();
const toolNameSchema = z.string()
  .trim()
  .min(1, 'body.name is required')
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/, 'tool name contains unsupported characters');
const stepSchema = z.object({
  tool: toolNameSchema,
  args: z.unknown().optional(),
  note: z.unknown().optional(),
  rationale: z.unknown().optional(),
}).passthrough();
const maxConcurrencySchema = z.preprocess(
  (value) => (value == null || value === '' ? undefined : Number(value)),
  z.number().int().min(1).max(16).optional(),
);

export const toolSearchQuerySchema = z.object({
  query: z.string().trim().max(200).default(''),
  limit: limitSchema,
});

export const toolCallBodySchema = objectBodySchema.pipe(z.object({
  name: toolNameSchema,
  args: z.unknown().optional(),
  trustedRoot: optionalTrustedRootSchema,
}).passthrough());

export const subagentRunBodySchema = objectBodySchema.pipe(z.object({
  goal: z.unknown().optional(),
  steps: z.array(stepSchema, 'body.steps must be an array').optional(),
  trustedRoot: optionalTrustedRootSchema,
  stopOnError: z.boolean().optional(),
}).passthrough());

const childAgentSchema = z.object({
  goal: z.unknown().optional(),
  task: z.unknown().optional(),
  steps: z.array(stepSchema, 'agent.steps must be an array').optional(),
}).passthrough();
export const subagentParallelBodySchema = objectBodySchema.pipe(z.object({
  goal: z.unknown().optional(),
  agents: z.array(childAgentSchema, 'body.agents must be an array').optional(),
  trustedRoot: optionalTrustedRootSchema,
  stopOnError: z.boolean().optional(),
  maxConcurrency: maxConcurrencySchema,
}).passthrough());

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export function parseToolSearchQuery(
  response: HttpResponseLike,
  requestUrl: URL,
): z.output<typeof toolSearchQuerySchema> | null {
  const parsed = toolSearchQuerySchema.safeParse({
    query: requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '',
    limit: requestUrl.searchParams.get('limit'),
  });
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, 'invalid tool search query') });
    return null;
  }
  return parsed.data;
}

export function parseToolBody<S extends z.ZodType>(
  response: HttpResponseLike,
  schema: S,
  body: unknown,
  fallbackMessage: string,
): z.output<S> | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, fallbackMessage) });
    return null;
  }
  return parsed.data;
}
