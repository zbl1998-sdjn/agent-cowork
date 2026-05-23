import { sendJson, withJsonBody } from '../http/request-utils.js';
import { buildPlan } from '../runtime/plan-builder.js';

// Plan mode route: propose a plan (no execution). The client approves the steps
// and then POSTs them to /api/subagent/run to execute.
//
//   POST /api/plan  { goal } -> { goal, steps:[{tool,args,rationale}], executable }

export async function handlePlanRoutes({ request, response, pathname, requestContext, toolRegistry, planner }) {
  if (!toolRegistry) {
    return false;
  }
  if (request.method === 'POST' && pathname === '/api/plan') {
    await withJsonBody(request, response, async (body) => {
      try {
        const plan = await buildPlan({ goal: body?.goal, registry: toolRegistry, planner });
        sendJson(response, 200, { context: requestContext, ...plan });
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
      }
    });
    return true;
  }
  return false;
}
