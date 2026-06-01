// 可视化路由输入协议(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中校验 /api/viz/render* JSON body 与 /api/artifacts/*/:id 路径参数。
import { z } from 'zod';
import { decodePathSegment, sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';

const ARTIFACT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const APPROVAL_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const objectBodySchema = z.preprocess(objectBody, z.object({}).loose());
const artifactIdSchema = z.string()
  .trim()
  .min(1, 'artifact id is required')
  .max(64)
  .regex(ARTIFACT_ID_RE, 'artifact id contains unsupported characters');
const approvalIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(APPROVAL_ID_RE, 'approval id contains unsupported characters');

export const vizRenderBodySchema = objectBodySchema.pipe(z.object({
  id: artifactIdSchema.optional(),
  title: z.string().max(200).optional(),
  kind: z.string().trim().max(32).optional(),
  data: z.unknown().optional(),
  options: z.unknown().optional(),
  code: z.string().max(200_000).optional(),
  definition: z.string().max(200_000).optional(),
  dataSource: z.unknown().optional(),
  persist: z.boolean().optional(),
  trustedRoot: z.unknown().optional(),
  approvalId: approvalIdSchema.optional(),
  fileOperationApprovalId: approvalIdSchema.optional(),
}).loose());

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export function parseVizBody(
  response: HttpResponseLike,
  body: unknown,
  fallbackMessage: string,
): z.output<typeof vizRenderBodySchema> | null {
  const parsed = vizRenderBodySchema.safeParse(body);
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, fallbackMessage) });
    return null;
  }
  return parsed.data;
}

export function parseArtifactIdPath(
  response: HttpResponseLike,
  pathname: string,
  prefix: string,
): string | null {
  const decoded = decodePathSegment(pathname.slice(prefix.length));
  const parsed = decoded == null ? null : artifactIdSchema.safeParse(decoded);
  if (!parsed || !parsed.success) {
    sendJson(response, 400, { error: 'invalid artifact id' });
    return null;
  }
  return parsed.data;
}
