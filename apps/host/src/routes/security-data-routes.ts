// 数据销毁/保留路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/security/data/* —— 工作区数据销毁计划(只读)、执行销毁(需 confirm)、
//       保留期清理。jail 固定为服务端 trustedRoot 下的 .AgentCowork,不接受客户端指定路径。
// 依赖:L0 request-utils + L1 security/data-purge。导出:handleSecurityDataRoutes。
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { applyRetention, buildPurgePlan, executePurgePlan, PURGE_SCOPES, type PurgeScope } from '../security/data-purge.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';

export type SecurityDataRouteOptions = {
  request: HttpRequestLike & { method?: string };
  response: HttpResponseLike;
  pathname: string;
  requestContext: unknown;
  trustedRoot: string;
};

export async function handleSecurityDataRoutes({
  request,
  response,
  pathname,
  requestContext,
  trustedRoot,
}: SecurityDataRouteOptions): Promise<boolean> {
  if (request.method === 'POST' && (pathname === '/api/security/data/purge-plan' || pathname === '/api/security/data/purge')) {
    await withJsonBody(request, response, (body) => {
      const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const scope = String(raw.scope || 'content').toLowerCase() as PurgeScope;
      if (!PURGE_SCOPES.includes(scope)) {
        sendJson(response, 400, { error: `无效的 scope,仅允许:${PURGE_SCOPES.join(', ')}` });
        return;
      }
      const plan = buildPurgePlan(trustedRoot, { scope });
      if (pathname.endsWith('/purge-plan')) {
        sendJson(response, 200, { context: requestContext, plan });
        return;
      }
      if (raw.confirm !== true) {
        sendJson(response, 428, { error: '销毁工作区数据是不可逆操作,必须显式传 confirm:true;先看 /purge-plan 确认删除范围。', plan });
        return;
      }
      const result = executePurgePlan(plan, { confirm: true });
      sendJson(response, 200, { context: requestContext, scope, removed: result.removed.length, plan });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/security/data/retention') {
    await withJsonBody(request, response, (body) => {
      const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const maxAgeDays = Math.max(1, Math.floor(Number(raw.maxAgeDays) || 0));
      if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
        sendJson(response, 400, { error: 'maxAgeDays 必须为 >=1 的整数' });
        return;
      }
      const result = applyRetention(trustedRoot, { maxAgeDays });
      sendJson(response, 200, { context: requestContext, maxAgeDays, removed: result.removed.length });
    });
    return true;
  }

  return false;
}
