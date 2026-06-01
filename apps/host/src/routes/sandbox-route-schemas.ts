// 沙箱路由输入协议(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中校验 /api/sandbox/exec 与 /api/sandbox/run-code 的 JSON body 外形。
import { z } from 'zod';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const objectBodySchema = z.preprocess(objectBody, z.object({}).loose());
const sandboxSpecShape = z.object({
  tool: z.unknown().optional(),
  args: z.unknown().optional(),
  cwd: z.unknown().optional(),
  timeoutMs: z.unknown().optional(),
  network: z.unknown().optional(),
  env: z.unknown().optional(),
}).loose();

export const sandboxExecBodySchema = objectBodySchema.pipe(z.object({
  spec: sandboxSpecShape.optional(),
  trustedRoot: z.unknown().optional(),
}).loose());

export const sandboxRunCodeBodySchema = objectBodySchema.pipe(z.object({
  tool: z.string().trim().min(1, 'tool is required').max(64),
  code: z.string(),
  prompt: z.string().max(4000).optional(),
  ext: z.string().trim().max(16).regex(/^[a-zA-Z0-9]+$/).optional(),
  timeoutMs: z.unknown().optional(),
  network: z.boolean().optional(),
  trustedRoot: z.unknown().optional(),
}).loose());

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export function parseSandboxBody<S extends z.ZodType>(
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
