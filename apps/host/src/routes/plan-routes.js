import { sendJson, withJsonBody } from '../http/request-utils.js';
import { buildPlan } from '../runtime/plan-builder.js';

/** @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest */
/** @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse */
/** @typedef {import('../runtime/plan-builder.js').PlanToolRegistry} PlanToolRegistry */
/** @typedef {import('../runtime/plan-builder.js').Planner} Planner */
/** @typedef {Error & { statusCode?: number }} RouteError */

// Plan mode route: propose a plan (no execution). The client approves the steps
// and then POSTs them to /api/subagent/run to execute.
//
//   POST /api/plan  { goal } -> { goal, steps:[{tool,args,rationale}], executable }

/** @param {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext?: Record<string, unknown>, toolRegistry?: PlanToolRegistry | null, planner?: Planner }} options */
export async function handlePlanRoutes({ request, response, pathname, requestContext, toolRegistry, planner }) {
  if (!toolRegistry) {
    return false;
  }
  if (request.method === 'POST' && pathname === '/api/plan') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = /** @type {{ goal?: unknown }} */ (body || {});
        const plan = await buildPlan({ goal: input.goal, registry: toolRegistry, planner });
        sendJson(response, 200, { context: requestContext, ...plan });
      } catch (err) {
        const error = /** @type {RouteError} */ (err);
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }
  return false;
}
