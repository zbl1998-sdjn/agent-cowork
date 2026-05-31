// 连接器 OAuth 路由输入协议(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中校验 /api/connectors/oauth/* 的 JSON body,把 provider/session/approval
//       等边界字段收紧到可审计的短 token,避免路径片段或任意对象穿透到运行时状态表。
import { z } from 'zod';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';

const CONNECTOR_ID_RE = /^[a-z0-9_-]{1,64}$/;
const ROUTE_TOKEN_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const optionalString = (value: unknown): unknown => (
  value == null || value === '' ? undefined : value
);

const objectBodySchema = z.preprocess(objectBody, z.object({}).passthrough());
const connectorIdSchema = z.preprocess(
  optionalString,
  z.string()
    .trim()
    .min(1)
    .max(64)
    .regex(CONNECTOR_ID_RE, 'connector id contains unsupported characters')
    .optional(),
);
const routeTokenSchema = z.preprocess(
  optionalString,
  z.string()
    .trim()
    .min(1)
    .max(128)
    .regex(ROUTE_TOKEN_RE, 'OAuth route token contains unsupported characters')
    .optional(),
);

export const connectorOAuthBodySchema = objectBodySchema.pipe(z.object({
  id: connectorIdSchema,
  scopes: z.unknown().optional(),
  approvalId: routeTokenSchema,
  oauthApprovalId: routeTokenSchema,
  clientSecret: z.unknown().optional(),
  sessionId: routeTokenSchema,
}).passthrough());

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export function parseConnectorOAuthBody(
  response: HttpResponseLike,
  body: unknown,
): z.output<typeof connectorOAuthBodySchema> | null {
  const parsed = connectorOAuthBodySchema.safeParse(body);
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, 'invalid connector OAuth request') });
    return null;
  }
  return parsed.data;
}
