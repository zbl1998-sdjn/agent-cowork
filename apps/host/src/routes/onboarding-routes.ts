// 引导路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/onboarding/* —— 返回按角色的配方/连接器推荐,供新用户引导界面。
// 依赖:L0 request-utils + L1 onboarding 推荐。导出:handleOnboardingRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { buildOnboardingRecommendations } from '../onboarding/recommendations.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { OnboardingInput } from '../onboarding/recommendations.js';

type RouteRequest = HttpRequestLike & { method?: string };
type OnboardingRouteOptions = { request: RouteRequest; response: HttpResponseLike; pathname: string };

const optionalStringField = z.preprocess(
  (value) => (typeof value === 'string' ? value : undefined),
  z.string().optional(),
);

const onboardingRecommendationsBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    role: optionalStringField,
    workspaceType: optionalStringField,
  }),
);

function parseRecommendationsBody(body: unknown): OnboardingInput {
  const input = onboardingRecommendationsBodySchema.parse(body);
  return { role: input.role, workspaceType: input.workspaceType };
}

export async function handleOnboardingRoutes({ request, response, pathname }: OnboardingRouteOptions): Promise<boolean> {
  if (request.method === 'POST' && pathname === '/api/onboarding/recommendations') {
    await withJsonBody(request, response, async (body) => {
      sendJson(response, 200, buildOnboardingRecommendations(parseRecommendationsBody(body)));
    });
    return true;
  }

  return false;
}
