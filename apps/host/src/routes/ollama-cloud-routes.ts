// Ollama Cloud 路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/ollama-cloud/* —— 触发 signin(返回设备配对 URL)、拉取云端模型。
//       固定子命令,pull 的模型名严格校验;这是当前用户工作区级操作(经认证),不改安全边界。
// 依赖:L0 request-utils + L1 engine/provider/ollama-cloud。导出:handleOllamaCloudRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import { ollamaPullCloud, ollamaSignin, RECOMMENDED_CLOUD_MODELS } from '../engine/provider/ollama-cloud.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type OllamaCloudRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext?: Record<string, unknown>;
};

const pullBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({ model: z.string() }),
);

export async function handleOllamaCloudRoutes({
  request,
  response,
  pathname,
  requestContext,
}: OllamaCloudRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/ollama-cloud/recommended') {
    sendJson(response, 200, { context: requestContext, models: RECOMMENDED_CLOUD_MODELS });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/ollama-cloud/signin') {
    try {
      const result = await ollamaSignin();
      sendJson(response, 200, { context: requestContext, ...result });
    } catch (err) {
      const error = err as RouteError;
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/ollama-cloud/pull') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = pullBodySchema.parse(body);
        const result = await ollamaPullCloud(input.model);
        sendJson(response, 200, { context: requestContext, ...result });
      } catch (err) {
        const error = err as RouteError;
        sendJson(response, error.statusCode || 500, { error: error.message });
      }
    });
    return true;
  }

  return false;
}
