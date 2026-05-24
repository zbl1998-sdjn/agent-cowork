import {
  headerValue,
  isAllowedOrigin,
  requiresOriginCheck,
  sendJson,
} from '../request-utils.js';

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

const PUBLIC_API_ROUTES = [
  ['POST', '/api/auth/register'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/guest'],
];

function isPublicApiRoute(method, pathname) {
  return PUBLIC_API_ROUTES.some(([m, p]) => m === method && p === pathname);
}

export function applyRequestMiddleware({
  request,
  response,
  pathname,
  requestContext,
  rateLimiter,
  requireAuth,
}) {
  response.setHeader('x-trace-id', requestContext.traceId);
  response.setHeader('x-tenant-id', requestContext.tenantId);
  response.setHeader('x-user-id', requestContext.userId);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }

  const requestOrigin = headerValue(request, 'origin');
  const originOk = isAllowedOrigin(requestOrigin);
  if (requestOrigin && originOk) {
    response.setHeader('access-control-allow-origin', requestOrigin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    response.setHeader(
      'access-control-allow-headers',
      'authorization,content-type,accept,idempotency-key,x-tenant-id,x-user-id,x-trace-id,last-event-id',
    );
    response.setHeader('access-control-max-age', '600');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(originOk ? 204 : 403);
    response.end();
    return true;
  }

  if (requiresOriginCheck(request.method, pathname) && !isAllowedOrigin(headerValue(request, 'origin'))) {
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
