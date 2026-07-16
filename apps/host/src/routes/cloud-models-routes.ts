// 云端模型开关路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/cloud-models —— 读取/写入本工作区"启用哪些公网云 provider"的用户开关。
//       写入后同步 gateway 环境变量,使既有出站策略把这些 provider 放行(customer_gateway)。
//       这是当前用户自己工作区的设置(经认证 + safeTrustedRoot 授权),不要求全局 admin;
//       出站预览与 egress-audit 照常记录。
// 依赖:L0 request-utils + L1 engine/provider/cloud-model-optin(经 syncCloudOptIn 回调注入)。
// 导出:handleCloudModelsRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import { listCloudProviders, readCloudOptIn, setCloudOptIn } from '../engine/provider/cloud-model-optin.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type CloudModelsRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl?: URL;
  requestContext?: Record<string, unknown>;
  safeTrustedRoot?: (input?: unknown) => string;
  syncCloudOptIn?: () => string;
};

const bodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    enabled: z.boolean().optional(),
    providers: z.array(z.string()).optional(),
    root: z.string().optional(),
  }),
);

export async function handleCloudModelsRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  safeTrustedRoot,
  syncCloudOptIn,
}: CloudModelsRouteOptions): Promise<boolean> {
  if (typeof safeTrustedRoot !== 'function' || pathname !== '/api/cloud-models') return false;

  if (request.method === 'GET') {
    try {
      const trustedRoot = safeTrustedRoot(requestUrl?.searchParams.get('root') || undefined);
      const optIn = readCloudOptIn(trustedRoot);
      sendJson(response, 200, { context: requestContext, ...optIn, available: listCloudProviders() });
    } catch (err) {
      const error = err as RouteError;
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (request.method === 'POST') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = bodySchema.parse(body);
        const trustedRoot = safeTrustedRoot(input.root || undefined);
        const optIn = setCloudOptIn(trustedRoot, { enabled: input.enabled === true, providers: input.providers ?? [] });
        syncCloudOptIn?.();
        sendJson(response, 200, { context: requestContext, ...optIn, available: listCloudProviders() });
      } catch (err) {
        const error = err as RouteError;
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }

  return false;
}
