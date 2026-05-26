import { sendJson, withJsonBody } from '../http/request-utils.js';

// Clarification (AskUserQuestion) routes.
//
//   POST /api/clarify              { question, options } -> pending clarification
//   GET  /api/clarify/:id          -> the clarification
//   POST /api/clarify/:id/answer   { value } -> answered clarification

const ANSWER_RE = /^\/api\/clarify\/([a-zA-Z0-9_-]+)\/answer$/;
const GET_RE = /^\/api\/clarify\/([a-zA-Z0-9_-]+)$/;

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {import('../runtime/clarifications.js').ClarificationStore} ClarificationStore
 * @typedef {{ question?: unknown, options?: unknown, value?: unknown }} ClarifyBody
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: Record<string, unknown>, clarifications?: ClarificationStore | null }} ClarifyRouteOptions
 */

/** @param {unknown} err */
function errorPayload(err) {
  const error = /** @type {Error & { statusCode?: number }} */ (err);
  return { status: error.statusCode || 400, body: { error: error.message } };
}

/** @param {ClarifyRouteOptions} options */
export async function handleClarifyRoutes({ request, response, pathname, requestContext, clarifications }) {
  if (!clarifications) {
    return false;
  }

  if (request.method === 'POST' && pathname === '/api/clarify') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {ClarifyBody} */ (body || {});
      try {
        const clarification = clarifications.create({
          question: input.question,
          options: input.options,
          context: requestContext,
        });
        sendJson(response, 200, { context: requestContext, clarification });
      } catch (err) {
        const error = errorPayload(err);
        sendJson(response, error.status, error.body);
      }
    });
    return true;
  }

  const answerMatch = pathname.match(ANSWER_RE);
  if (request.method === 'POST' && answerMatch) {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {ClarifyBody} */ (body || {});
      try {
        const clarification = clarifications.answer(answerMatch[1], input.value);
        sendJson(response, 200, { context: requestContext, clarification });
      } catch (err) {
        const error = errorPayload(err);
        sendJson(response, error.status, error.body);
      }
    });
    return true;
  }

  const getMatch = pathname.match(GET_RE);
  if (request.method === 'GET' && getMatch) {
    const clarification = clarifications.get(getMatch[1]);
    if (!clarification) {
      sendJson(response, 404, { error: 'clarification not found' });
      return true;
    }
    sendJson(response, 200, { context: requestContext, clarification });
    return true;
  }

  return false;
}
