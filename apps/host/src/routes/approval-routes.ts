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

const approvalDecisionSchema = z.enum(['once', 'session', 'reject']);

const approvalEnvelopeSchema = z.object({
  decision: z.unknown().optional(),
  answer: z.unknown().optional(),
}).loose();

const batchApprovalBodySchema = z.object({
  ids: z.array(approvalIdSchema)
    .min(1, 'ids must be a non-empty array of approval IDs')
    .max(MAX_BATCH_APPROVALS, `ids must contain at most ${MAX_BATCH_APPROVALS} approval IDs`)
    .transform((ids) => [...new Set(ids)]),
  decision: approvalDecisionSchema,
}).loose();

type ParsedApprovalBody =
  | { channel: 'decision'; decision: z.infer<typeof approvalDecisionSchema> }
  | { channel: 'answer'; answer: unknown };

function parseApprovalBody(body: unknown): ParsedApprovalBody | null {
  const result = approvalEnvelopeSchema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
  if (!result.success) return null;
  const hasDecision = Object.prototype.hasOwnProperty.call(result.data, 'decision');
  const hasAnswer = Object.prototype.hasOwnProperty.call(result.data, 'answer');
  if (hasDecision === hasAnswer) return null;
  if (hasAnswer) return { channel: 'answer', answer: result.data.answer };
  const decision = approvalDecisionSchema.safeParse(result.data.decision);
  return decision.success ? { channel: 'decision', decision: decision.data } : null;
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
      const input = batchApprovalBodySchema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      if (!input.success) {
        sendJson(response, 400, { error: 'ids and decision must contain valid approval values' });
        return;
      }
      const { ids, decision } = input.data;
      const results = await resolveMany(approvalRegistry, ids, decision, requestContext);
      const resolved = results.filter((item) => item.ok).length;
      sendJson(response, resolved > 0 ? 200 : 404, {
        context: requestContext,
        ids,
        ok: resolved === ids.length,
        resolved,
        results,
        decision,
      });
    });
    return true;
  }
  if (!/^\/api\/approvals\/[a-zA-Z0-9_-]+$/.test(pathname)) return false;
  await withJsonBody(request, response, async (body) => {
    const input = parseApprovalBody(body);
    if (!input) {
      sendJson(response, 400, { error: 'request must contain exactly one valid decision or answer' });
      return;
    }
    const id = pathname.split('/')[3] ?? '';
    const hasAnswer = input.channel === 'answer';
    const ok = hasAnswer
      ? await approvalRegistry.respond(id, input.answer, requestContext)
      : await approvalRegistry.resolve(id, input.decision, requestContext);
    sendJson(response, ok ? 200 : 404, {
      context: requestContext,
      id,
      ok,
      decision: input.channel === 'decision' ? input.decision : undefined,
      answer: input.channel === 'answer' ? input.answer : undefined,
    });
  });
  return true;
}
