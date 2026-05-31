// 引导路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/onboarding/* —— 返回按角色的配方/连接器推荐,供新用户引导界面。
// 依赖:L0 request-utils + L1 onboarding 推荐。导出:handleOnboardingRoutes。
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { buildOnboardingRecommendations } from '../onboarding/recommendations.js';

/** @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest */
/** @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse */

/** @param {{ request: RouteRequest, response: RouteResponse, pathname: string }} options */
export async function handleOnboardingRoutes({ request, response, pathname }) {
  if (request.method === 'POST' && pathname === '/api/onboarding/recommendations') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {{ role?: unknown, workspaceType?: unknown }} */ (body || {});
      sendJson(response, 200, buildOnboardingRecommendations(input));
    });
    return true;
  }

  return false;
}
