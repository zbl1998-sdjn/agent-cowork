import { sendJson, withJsonBody } from '../http/request-utils.js';

const APPROVAL_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_BATCH_APPROVALS = 100;

function approvalIds(body) {
  if (!body || !Array.isArray(body.ids)) return null;
  if (body.ids.length === 0) return null;
  if (body.ids.length > MAX_BATCH_APPROVALS) return null;
  const ids = [...new Set(body.ids)];
  return ids.every((id) => typeof id === 'string' && APPROVAL_ID_RE.test(id)) ? ids : null;
}

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

export async function handleApprovalRoutes({ request, response, pathname, requestContext, approvalRegistry }) {
  if (request.method !== 'POST') {
    return false;
  }
  if (pathname === '/api/approvals/batch') {
    await withJsonBody(request, response, async (body) => {
      const ids = approvalIds(body);
      if (!ids) {
        sendJson(response, 400, { error: 'ids must be a non-empty array of approval IDs' });
        return;
      }
      const results = await resolveMany(approvalRegistry, ids, body && body.decision, requestContext);
      const resolved = results.filter((item) => item.ok).length;
      sendJson(response, resolved > 0 ? 200 : 404, {
        context: requestContext,
        ids,
        ok: resolved === ids.length,
        resolved,
        results,
        decision: body && body.decision,
      });
    });
    return true;
  }
  if (!/^\/api\/approvals\/[a-zA-Z0-9_-]+$/.test(pathname)) return false;
  await withJsonBody(request, response, async (body) => {
    const id = pathname.split('/')[3];
    const hasAnswer = body && typeof body.answer !== 'undefined';
    const ok = hasAnswer
      ? await approvalRegistry.respond(id, body.answer, requestContext)
      : await approvalRegistry.resolve(id, body && body.decision, requestContext);
    sendJson(response, ok ? 200 : 404, {
      context: requestContext,
      id,
      ok,
      decision: body && body.decision,
      answer: hasAnswer ? body.answer : undefined,
    });
  });
  return true;
}
