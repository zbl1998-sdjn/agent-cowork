import { sendJson, withJsonBody } from '../http/request-utils.js';

const APPROVAL_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_BATCH_APPROVALS = 100;

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {{ ids?: unknown[], decision?: unknown, answer?: unknown }} ApprovalBody
 * @typedef {{ id: string, ok: boolean }} ApprovalResult
 * @typedef {{ resolve(id: string, decision: unknown, context: Record<string, unknown>): boolean | Promise<boolean>, respond(id: string, answer: unknown, context: Record<string, unknown>): boolean | Promise<boolean>, resolveMany?: (ids: string[], decision: unknown, context: Record<string, unknown>) => ApprovalResult[] | Promise<ApprovalResult[]> }} ApprovalRegistry
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: Record<string, unknown>, approvalRegistry: ApprovalRegistry }} ApprovalRouteOptions
 */

/** @param {unknown} body @returns {string[] | null} */
function approvalIds(body) {
  const input = /** @type {ApprovalBody} */ (body || {});
  if (!Array.isArray(input.ids)) return null;
  if (input.ids.length === 0) return null;
  if (input.ids.length > MAX_BATCH_APPROVALS) return null;
  const ids = [...new Set(input.ids)];
  return ids.every((id) => typeof id === 'string' && APPROVAL_ID_RE.test(id)) ? /** @type {string[]} */ (ids) : null;
}

/** @param {ApprovalRegistry} approvalRegistry @param {string[]} ids @param {unknown} decision @param {Record<string, unknown>} requestContext @returns {Promise<ApprovalResult[]>} */
async function resolveMany(approvalRegistry, ids, decision, requestContext) {
  if (approvalRegistry && typeof approvalRegistry.resolveMany === 'function') {
    return approvalRegistry.resolveMany(ids, decision, requestContext);
  }
  const results = [];
  for (const id of ids) {
    results.push({ id, ok: await approvalRegistry.resolve(id, decision, requestContext) });
  }
  return results;
}

/** @param {ApprovalRouteOptions} options */
export async function handleApprovalRoutes({ request, response, pathname, requestContext, approvalRegistry }) {
  if (request.method !== 'POST') {
    return false;
  }
  if (pathname === '/api/approvals/batch') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {ApprovalBody} */ (body || {});
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
    const input = /** @type {ApprovalBody} */ (body || {});
    const id = pathname.split('/')[3];
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
