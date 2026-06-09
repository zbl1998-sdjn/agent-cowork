// 计划路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/plan/* —— 把目标交给 planner 生成可审批计划,或将批准后的计划交子代理执行。
// 依赖:L0 request-utils + L2 plan-builder/subagent + L1 tools 注册表(经参数注入)。导出:handlePlanRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { buildPlan } from '../runtime/plan-builder.js';
import { omitUndefined } from '../util/object.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { Planner, PlanToolRegistry } from '../runtime/plan-builder.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type PlanRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext?: Record<string, unknown>;
  toolRegistry?: PlanToolRegistry | null;
  planner?: Planner;
};

const planBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    goal: z.string().trim().min(1, 'goal is required').max(4000, 'goal too long (max 4000 chars)'),
  }),
);

// 计划模式只生成待审批计划,不执行;客户端批准后再 POST 到 /api/subagent/run。
export async function handlePlanRoutes({
  request,
  response,
  pathname,
  requestContext,
  toolRegistry,
  planner,
}: PlanRouteOptions): Promise<boolean> {
  if (!toolRegistry) {
    return false;
  }
  if (request.method === 'POST' && pathname === '/api/plan') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = planBodySchema.parse(body);
        const plan = await buildPlan(omitUndefined({ goal: input.goal, registry: toolRegistry, planner }));
        sendJson(response, 200, { context: requestContext, ...plan });
      } catch (err) {
        const error = err as RouteError;
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }
  return false;
}
