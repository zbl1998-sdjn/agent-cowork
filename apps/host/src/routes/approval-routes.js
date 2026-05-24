import { sendJson, withJsonBody } from '../http/request-utils.js';

export async function handleApprovalRoutes({ request, response, pathname, requestContext, approvalRegistry }) {
  if (request.method !== 'POST' || !/^\/api\/approvals\/[a-zA-Z0-9_-]+$/.test(pathname)) {
    return false;
  }
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
