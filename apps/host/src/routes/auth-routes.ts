// 鉴权路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/auth/* —— 注册/登录/访客/登出/会话查询,签发会话 token。
// 依赖:L0 request-utils + L1 auth 用户存储(经参数注入)。导出:handleAuthRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody, headerValue } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { Identity, SessionIdentity } from '../auth/user-store.js';
import type { EnrollmentPolicy } from '../auth/enrollment-policy.js';

// 本地鉴权路由只暴露注册、登录、访客、当前会话和登出;所有 token 都交由 authStore 解析。

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type AuthStoreLike = {
  register(username: string, password: string): Identity;
  createSession(identity: Identity): string;
  createGuest(): SessionIdentity;
  login(username: string, password: string): SessionIdentity;
  resolveToken(token: string): Identity | null;
  logout(token: string): boolean;
};
type AuthRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext?: Record<string, unknown>;
  authStore?: AuthStoreLike | null;
  enrollmentPolicy?: EnrollmentPolicy | null;
};

const credentialsBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    username: z.string().trim().min(1, 'username is required'),
    password: z.string().min(1, 'password is required'),
  }),
);

function bearer(request: RouteRequest): string {
  const value = headerValue(request, 'authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function errorPayload(err: unknown, fallbackStatus: number): { status: number; body: { error: string } } {
  if (err instanceof z.ZodError) {
    return { status: 400, body: { error: err.issues[0]?.message || 'invalid auth request' } };
  }
  if (err instanceof Error) {
    const error = err as RouteError;
    return { status: error.statusCode || fallbackStatus, body: { error: error.message } };
  }
  return { status: fallbackStatus, body: { error: 'auth request failed' } };
}

export async function handleAuthRoutes({ request, response, pathname, requestContext, authStore, enrollmentPolicy }: AuthRouteOptions): Promise<boolean> {
  if (!authStore) {
    return false;
  }

  if (request.method === 'POST' && pathname === '/api/auth/register') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = credentialsBodySchema.parse(body);
        if (!enrollmentPolicy?.consume(headerValue(request, 'x-kcw-enrollment-token'))) {
          sendJson(response, 403, { error: 'a valid one-time enrollment capability is required' });
          return;
        }
        const identity = authStore.register(input.username, input.password);
        const token = authStore.createSession(identity);
        sendJson(response, 200, { ...identity, token });
      } catch (err) {
        const error = errorPayload(err, 400);
        sendJson(response, error.status, error.body);
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/auth/guest') {
    // 「跳过登录」仍签发隔离访客身份与 token,避免出现真正未鉴权 API 访问。
    try {
      if (!enrollmentPolicy?.consume(headerValue(request, 'x-kcw-enrollment-token'))) {
        sendJson(response, 403, { error: 'a valid one-time enrollment capability is required' });
        return true;
      }
      sendJson(response, 200, authStore.createGuest());
    } catch (err) {
      const error = errorPayload(err, 500);
      sendJson(response, error.status, error.body);
    }
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = credentialsBodySchema.parse(body);
        sendJson(response, 200, authStore.login(input.username, input.password));
      } catch (err) {
        const error = errorPayload(err, 401);
        sendJson(response, error.status, error.body);
      }
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/auth/me') {
    const session = authStore.resolveToken(bearer(request));
    if (!session) {
      sendJson(response, 401, { error: 'not authenticated' });
      return true;
    }
    sendJson(response, 200, { userId: session.userId, tenantId: session.tenantId, username: session.username, context: requestContext });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    sendJson(response, 200, { ok: authStore.logout(bearer(request)) });
    return true;
  }

  return false;
}
