// 通用 HTTP 中间件(host · L0 基础层 · http/middleware)
// ---------------------------------------------------------------------------
// 职责:请求进入路由前的统一前置处理——注入安全响应头、CORS/Host 同源校验(防 DNS rebinding/CSRF)、
//       按租户限流。命中拦截即直接响应并短路。是 L4 server.js 装配在路由链之前的安全闸门。
// 依赖:同层 request-utils(同源/限流原语)。导出:SECURITY_HEADERS / applyRequestMiddleware。
import {
  headerValue,
  isAllowedHost,
  isAllowedOrigin,
  requiresOriginCheck,
  sendJson,
} from '../request-utils.js';

export type MiddlewareRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};
export type MiddlewareResponse = {
  setHeader(name: string, value: string): unknown;
  removeHeader?(name: string): unknown;
  writeHead(statusCode: number, headers?: Record<string, string | number>): unknown;
  end(chunk?: string | Buffer): unknown;
};
export type RequestContext = { traceId: string; tenantId: string; userId: string; authenticated?: boolean };
export type RateLimitDecision = { limit: number; remaining: number; allowed: boolean; retryAfterSec: number };
export type RateLimiterLike = { take(key: string): RateLimitDecision };
export type RequestMiddlewareOptions = {
  request: MiddlewareRequest;
  response: MiddlewareResponse;
  pathname: string;
  requestContext: RequestContext;
  rateLimiter?: RateLimiterLike | null;
  requireAuth?: boolean;
  validateHost?: boolean;
  onlyOfficePublicHost?: string;
};

// 内容安全策略(CSP):本地 sidecar 直接服务已构建的 SPA。脚本仅同源(禁内联/eval,
// 收敛 XSS 执行面);允许内联样式(前端运行时注入样式)与 data:/blob: 图片、data: 字体;
// 连接限同源(同源 API / SSE);禁用插件对象、限制 base-uri、禁止被任意页面 iframe 嵌套。
// Tauri 桌面端有独立 CSP(tauri.conf.json),不受此 HTTP 响应头影响。
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
});

const OFFICE_WEB_FRAME_PATH = '/office-web-frame.html';
const OFFICE_WEB_FRAME_SCRIPT_PATH = '/vendor/office-web-frame.js';
const ONLYOFFICE_EDITOR_PATH = '/onlyoffice-editor.html';
const OFFICE_WEB_FRAME_CSP = CONTENT_SECURITY_POLICY.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

const PUBLIC_API_ROUTES = [
  ['POST', '/api/auth/register'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/guest'],
  ['GET', '/api/artifacts/onlyoffice/content'],
  ['POST', '/api/artifacts/onlyoffice/callback'],
];

const ONLYOFFICE_PUBLIC_ROUTES = [
  ['GET', '/api/artifacts/onlyoffice/content'],
  ['POST', '/api/artifacts/onlyoffice/callback'],
];

function matchesRoute(routes: string[][], method: unknown, pathname: string): boolean {
  const requestMethod = String(method || '').toUpperCase();
  return routes.some(([m, p]) => m === requestMethod && p === pathname);
}

function isPublicApiRoute(method: unknown, pathname: string): boolean {
  return matchesRoute(PUBLIC_API_ROUTES, method, pathname);
}

function isOnlyOfficePublicRoute(method: unknown, pathname: string): boolean {
  return matchesRoute(ONLYOFFICE_PUBLIC_ROUTES, method, pathname);
}

export function applyRequestMiddleware({
  request,
  response,
  pathname,
  requestContext,
  rateLimiter,
  requireAuth,
  validateHost,
  onlyOfficePublicHost,
}: RequestMiddlewareOptions): boolean {
  // 防 DNS rebinding:Host 必须是回环 host 或 Tauri webview;该检查先于所有路径/方法执行。
  // Origin 校验只覆盖会改状态的 /api/* 请求,所以 GET 也必须过 Host 闸门。
  const requestHost = headerValue(request, 'host');
  const externalOnlyOfficeHostAllowed = isOnlyOfficePublicRoute(request.method, pathname)
    && Boolean(onlyOfficePublicHost)
    && String(requestHost || '').trim().toLowerCase() === String(onlyOfficePublicHost).trim().toLowerCase();
  if (validateHost !== false && !isAllowedHost(requestHost) && !externalOnlyOfficeHostAllowed) {
    sendJson(response, 403, { error: 'Host not allowed' });
    return true;
  }

  response.setHeader('x-trace-id', requestContext.traceId);
  response.setHeader('x-tenant-id', requestContext.tenantId);
  response.setHeader('x-user-id', requestContext.userId);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  // 仅固定的本地网页编辑画布允许被同源主界面嵌入；其他页面继续保持 DENY / frame-ancestors 'none'。
  if (pathname === OFFICE_WEB_FRAME_PATH) {
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Content-Security-Policy', OFFICE_WEB_FRAME_CSP);
  }
  // sandbox 会把画布变成不透明来源；仅放行这一个无数据的固定桥脚本供该沙箱加载。
  if (pathname === OFFICE_WEB_FRAME_SCRIPT_PATH) {
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
  // 该页面由签名 session token 保护，必须允许 Tauri 主界面跨 origin 嵌入；动态 CSP 在路由响应中收紧。
  if (pathname === ONLYOFFICE_EDITOR_PATH) response.removeHeader?.('X-Frame-Options');

  const requestOrigin = headerValue(request, 'origin');
  const originOk = isAllowedOrigin(requestOrigin, requestHost);
  if (requestOrigin && originOk) {
    response.setHeader('access-control-allow-origin', requestOrigin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    response.setHeader(
      'access-control-allow-headers',
      'authorization,content-type,accept,idempotency-key,x-tenant-id,x-user-id,x-trace-id,x-acw-enrollment-token,x-kcw-enrollment-token,last-event-id',
    );
    response.setHeader('access-control-max-age', '600');
    // Private Network Access(Chromium/WebView2):Tauri 主界面(tauri.localhost)属"public"
    // 地址空间,fetch 到 127.0.0.1(loopback/private)会被 PNA 拦成 "Failed to fetch",
    // 除非预检回 Allow-Private-Network。只对已通过白名单校验的自有 origin、且请求显式声明
    // 需要私网访问时才回,不对任意网页放开。
    if (headerValue(request, 'access-control-request-private-network') === 'true') {
      response.setHeader('access-control-allow-private-network', 'true');
    }
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(originOk ? 204 : 403);
    response.end();
    return true;
  }

  if (requiresOriginCheck(request.method, pathname) && !originOk) {
    sendJson(response, 403, { error: 'Origin not allowed' });
    return true;
  }

  if (rateLimiter && pathname.startsWith('/api/')) {
    const rl = rateLimiter.take(requestContext.tenantId);
    response.setHeader('X-RateLimit-Limit', String(rl.limit));
    response.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    if (!rl.allowed) {
      response.setHeader('Retry-After', String(rl.retryAfterSec));
      sendJson(response, 429, { error: 'rate limit exceeded; slow down', retryAfterSec: rl.retryAfterSec });
      return true;
    }
  }

  if (requireAuth && pathname.startsWith('/api/') && !isPublicApiRoute(request.method, pathname) && !requestContext.authenticated) {
    sendJson(response, 401, { error: 'authentication required' });
    return true;
  }
  return false;
}
