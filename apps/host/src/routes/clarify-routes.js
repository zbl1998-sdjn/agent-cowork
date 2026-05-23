import { sendJson, withJsonBody } from '../http/request-utils.js';

// Clarification (AskUserQuestion) routes.
//
//   POST /api/clarify              { question, options } -> pending clarification
//   GET  /api/clarify/:id          -> the clarification
//   POST /api/clarify/:id/answer   { value } -> answered clarification

const ANSWER_RE = /^\/api\/clarify\/([a-zA-Z0-9_-]+)\/answer$/;
const GET_RE = /^\/api\/clarify\/([a-zA-Z0-9_-]+)$/;

export async function handleClarifyRoutes({ request, response, pathname, requestContext, clarifications }) {
  if (!clarifications) {
    return false;
  }

  if (request.method === 'POST' && pathname === '/api/clarify') {
    await withJsonBody(request, response, async (body) => {
      try {
        const clarification = clarifications.create({
          question: body && body.question,
          options: body && body.options,
          context: requestContext,
        });
        sendJson(response, 200, { context: requestContext, clarification });
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
      }
    });
    return true;
  }

  const answerMatch = pathname.match(ANSWER_RE);
  if (request.method === 'POST' && answerMatch) {
    await withJsonBody(request, response, async (body) => {
      try {
        const clarification = clarifications.answer(answerMatch[1], body ? body.value : undefined);
        sendJson(response, 200, { context: requestContext, clarification });
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
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
