// 审批路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/approvals/* —— UI 把审批决定(once/session/reject)回传,解决审批登记表中的待决项。
// 依赖:L0 request-utils + L2 approvals 登记表(经参数注入)。导出:handleApprovalRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';

const APPROVAL_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_BATCH_APPROVALS = 100;

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = Record<string, unknown>;
type ApprovalResult = { id: string; ok: boolean };
type ApprovalRegistry = {
  resolve(id: string, decision: unknown, context: RequestContext): boolean | Promise<boolean>;
  respond(id: string, answer: unknown, context: RequestContext): boolean | Promise<boolean>;
  resolveMany?: (ids: string[], decision: unknown, context: RequestContext) => ApprovalResult[] | Promise<ApprovalResult[]>;
};
type ApprovalRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  approvalRegistry: ApprovalRegistry;
};

const approvalIdSchema = z.string().regex(APPROVAL_ID_RE, 'approval id contains unsupported characters');

const approvalBodySchema = z.object({
  decision: z.unknown().optional(),
  answer: z.unknown().optional(),
}).loose();

const batchApprovalBodySchema = approvalBodySchema.extend({
  ids: z.array(approvalIdSchema)
    .min(1, 'ids must be a non-empty array of approval IDs')
    .max(MAX_BATCH_APPROVALS, `ids must contain at most ${MAX_BATCH_APPROVALS} approval IDs`)
    .transform((ids) => [...new Set(ids)]),
}).loose();

function parseBody(body: unknown): z.infer<typeof approvalBodySchema> {
  const result = approvalBodySchema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
  return result.success ? result.data : {};
}

function approvalIds(body: unknown): string[] | null {
  const result = batchApprovalBodySchema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
  return result.success ? result.data.ids : null;
}

async function resolveMany(
  approvalRegistry: ApprovalRegistry,
  ids: string[],
  decision: unknown,
  requestContext: RequestContext,
): Promise<ApprovalResult[]> {
  if (typeof approvalRegistry.resolveMany === 'function') {
    return approvalRegistry.resolveMany(ids, decision, requestContext);
  }
  const results: ApprovalResult[] = [];
  for (const id of ids) {
    results.push({ id, ok: await approvalRegistry.resolve(id, decision, requestContext) });
  }
  return results;
}

export async function handleApprovalRoutes({ request, response, pathname, requestContext, approvalRegistry }: ApprovalRouteOptions): Promise<boolean> {
  if (request.method !== 'POST') {
    return false;
  }
  if (pathname === '/api/approvals/batch') {
    await withJsonBody(request, response, async (body) => {
      const input = parseBody(body);
      const ids = approvalIds(body);
      if (!ids) {
        sendJson(response, 400, { error: 'ids must be a non-empty array of approval IDs' });
        return;
      }
      const results = await resolveMany(approvalRegistry, ids, input.decision, requestContext);
      const resolved = results.filter((item) => item.ok).length;
      sendJson(response, resolved > 0 ? 200 : 404, {
        context: requestContext,
        ids,
        ok: resolved === ids.length,
        resolved,
        results,
        decision: input.decision,
      });
    });
    return true;
  }
  if (!/^\/api\/approvals\/[a-zA-Z0-9_-]+$/.test(pathname)) return false;
  await withJsonBody(request, response, async (body) => {
    const input = parseBody(body);
    const id = pathname.split('/')[3] ?? '';
    const hasAnswer = typeof input.answer !== 'undefined';
    const ok = hasAnswer
      ? await approvalRegistry.respond(id, input.answer, requestContext)
      : await approvalRegistry.resolve(id, input.decision, requestContext);
    sendJson(response, ok ? 200 : 404, {
      context: requestContext,
      id,
      ok,
      decision: input.decision,
      answer: hasAnswer ? input.answer : undefined,
    });
  });
  return true;
}
