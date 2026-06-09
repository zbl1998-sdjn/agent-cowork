// 技能路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/skills/* —— 列出技能、按 id 开关启用状态。
// 依赖:L0 request-utils + L1 skills 注册表(经参数注入)。导出:handleSkillRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';

type RouteRequest = HttpRequestLike & { method?: string };
type SkillRegistryLike = {
  list(): unknown[];
  isEnabled(id: string): boolean;
  setEnabled(id: string, enabled: boolean): unknown;
};
type RouteError = Error & { statusCode?: number };
type SkillRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext?: Record<string, unknown>;
  skillRegistry?: SkillRegistryLike | null;
};

// 技能路由清单:
//   GET  /api/skills              -> 返回每个技能的 manifest 与启用状态
//   POST /api/skills/:id/toggle   -> { enabled?: bool };省略 enabled 时取反并返回技能
// 开关技能属于设置变更,按目标值幂等,所以不要求 Idempotency-Key。

const TOGGLE_RE = /^\/api\/skills\/([a-zA-Z0-9_-]+)\/toggle$/;

const skillToggleBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    enabled: z.preprocess((value) => (typeof value === 'boolean' ? value : undefined), z.boolean().optional()),
  }),
);

export async function handleSkillRoutes({
  request,
  response,
  pathname,
  requestContext,
  skillRegistry,
}: SkillRouteOptions): Promise<boolean> {
  if (!skillRegistry) {
    return false;
  }

  if (request.method === 'GET' && pathname === '/api/skills') {
    sendJson(response, 200, { context: requestContext, skills: skillRegistry.list() });
    return true;
  }

  const match = pathname.match(TOGGLE_RE);
  if (request.method === 'POST' && match) {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = skillToggleBodySchema.parse(body);
        const skillId = match[1] ?? '';
        const next = typeof input.enabled === 'boolean' ? input.enabled : !skillRegistry.isEnabled(skillId);
        const skill = skillRegistry.setEnabled(skillId, next);
        sendJson(response, 200, { context: requestContext, skill });
      } catch (err) {
        const error = err as RouteError;
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }

  return false;
}
