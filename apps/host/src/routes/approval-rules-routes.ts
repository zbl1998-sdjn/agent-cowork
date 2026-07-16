// 审批规则路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/approval-rules/* —— 列出/删除工作区级 always-allow 审批规则。
//       新增规则只能经审批卡的 workspace 决定,不提供 API 直加,防止绕过人工确认。
//       授权口径:这是当前用户自己工作区的设置(经认证 + safeTrustedRoot 工作区授权),
//       不是 host 全局状态,因此不要求 global-mutation-admin;删除规则只会收紧审批。
// 依赖:L0 request-utils + L2 runtime/approval-rules。导出:handleApprovalRulesRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import { listWorkspaceApprovalRules, removeWorkspaceApprovalRule } from '../runtime/approval-rules.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type ApprovalRulesRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl?: URL;
  requestContext?: Record<string, unknown>;
  safeTrustedRoot?: (input?: unknown) => string;
};

// 路由清单:
//   GET  /api/approval-rules?root=…          -> { alwaysAllow: string[] }
//   POST /api/approval-rules/:tool/remove    -> { root?: string };幂等删除并返回最新名单
const REMOVE_RE = /^\/api\/approval-rules\/([A-Za-z][A-Za-z0-9_.-]{0,63})\/remove$/;

const removeBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({ root: z.string().optional() }),
);

export async function handleApprovalRulesRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  safeTrustedRoot,
}: ApprovalRulesRouteOptions): Promise<boolean> {
  if (typeof safeTrustedRoot !== 'function') return false;

  if (request.method === 'GET' && pathname === '/api/approval-rules') {
    try {
      const trustedRoot = safeTrustedRoot(requestUrl?.searchParams.get('root') || undefined);
      sendJson(response, 200, { context: requestContext, alwaysAllow: listWorkspaceApprovalRules(trustedRoot) });
    } catch (err) {
      const error = err as RouteError;
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  const match = pathname.match(REMOVE_RE);
  if (request.method === 'POST' && match) {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = removeBodySchema.parse(body);
        const trustedRoot = safeTrustedRoot(input.root || undefined);
        const alwaysAllow = removeWorkspaceApprovalRule(trustedRoot, match[1] ?? '');
        sendJson(response, 200, { context: requestContext, removed: match[1], alwaysAllow });
      } catch (err) {
        const error = err as RouteError;
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }

  return false;
}
