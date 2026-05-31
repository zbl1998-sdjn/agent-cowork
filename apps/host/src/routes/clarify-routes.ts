// 澄清路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/clarify/* —— UI 回传对澄清提问(AskUserQuestion)的选择,解决待决问题。
// 依赖:L0 request-utils + L2 clarifications 登记表(经参数注入)。导出:handleClarifyRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { ClarificationStore } from '../runtime/clarifications.js';

// Clarification (AskUserQuestion) routes.
//
//   POST /api/clarify              { question, options } -> pending clarification
//   GET  /api/clarify/:id          -> the clarification
//   POST /api/clarify/:id/answer   { value } -> answered clarification

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type ClarifyRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: Record<string, unknown>;
  clarifications?: ClarificationStore | null;
};

const ANSWER_RE = /^\/api\/clarify\/([a-zA-Z0-9_-]+)\/answer$/;
const GET_RE = /^\/api\/clarify\/([a-zA-Z0-9_-]+)$/;
const MAX_QUESTION_LENGTH = 2000;
const MAX_OPTION_COUNT = 8;

const createClarificationBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    question: z.string()
      .trim()
      .min(1, 'clarification question is required')
      .max(MAX_QUESTION_LENGTH, 'clarification question too long'),
    // Keep the route boundary tolerant: the runtime store already normalizes
    // option shape, while this caps fan-out before values enter the registry.
    options: z.preprocess(
      (value) => (Array.isArray(value) ? value.slice(0, MAX_OPTION_COUNT) : []),
      z.array(z.unknown()).optional(),
    ),
  }),
);

const answerClarificationBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({ value: z.unknown().optional() }),
);

function errorPayload(err: unknown): { status: number; body: { error?: string } } {
  if (err instanceof Error) {
    const error = err as RouteError;
    return { status: error.statusCode || 400, body: { error: error.message } };
  }
  return { status: 400, body: { error: 'invalid clarification request' } };
}

export async function handleClarifyRoutes({
  request,
  response,
  pathname,
  requestContext,
  clarifications,
}: ClarifyRouteOptions): Promise<boolean> {
  if (!clarifications) {
    return false;
  }

  if (request.method === 'POST' && pathname === '/api/clarify') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = createClarificationBodySchema.parse(body);
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
      try {
        const input = answerClarificationBodySchema.parse(body);
        const clarification = clarifications.answer(answerMatch[1] ?? '', input.value);
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
    const clarification = clarifications.get(getMatch[1] ?? '');
    if (!clarification) {
      sendJson(response, 404, { error: 'clarification not found' });
      return true;
    }
    sendJson(response, 200, { context: requestContext, clarification });
    return true;
  }

  return false;
}
