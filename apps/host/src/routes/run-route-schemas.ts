// 运行历史路由查询契约(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中校验 /api/tasks、/api/runs、/api/runs/index 的查询参数,保持 run-routes 主体聚焦于路由编排。
import { z } from 'zod';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';

const limitSchema = (defaultValue: number): z.ZodType<number> => z.preprocess(
  (value) => (value == null || value === '' ? undefined : Number(value)),
  z.number().int().min(1).max(500).default(defaultValue),
);

const optionalFilterSchema = z.preprocess(
  (value) => (value == null || value === '' ? undefined : value),
  z.string().trim().max(96).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
);

export const taskListQuerySchema = z.object({ limit: limitSchema(20) });
export const runListQuerySchema = z.object({ limit: limitSchema(20) });
export const runIndexQuerySchema = z.object({
  limit: limitSchema(50),
  status: optionalFilterSchema,
  type: optionalFilterSchema,
  recipeId: optionalFilterSchema,
});

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export function parseRunQuery<T>(
  response: HttpResponseLike,
  schema: z.ZodType<T>,
  input: Record<string, string | null>,
  fallback: string,
): T | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, fallback) });
    return null;
  }
  return parsed.data;
}
