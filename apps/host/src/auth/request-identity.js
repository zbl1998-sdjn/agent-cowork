import { headerValue, stableHeader } from '../http/request-utils.js';
import { resolveJwtIdentity } from './jwt.js';

export function attachRequestIdentity({
  request,
  requestContext,
  authStore,
  jwtSecret,
  trustIdentityHeaders,
}) {
  const authHeader = headerValue(request, 'authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    let session = jwtSecret ? resolveJwtIdentity(token, jwtSecret) : null;
    if (!session) session = authStore.resolveToken(token);
    if (session) {
      requestContext.authenticated = true;
      if (session.userId) requestContext.userId = session.userId;
      if (session.tenantId) requestContext.tenantId = session.tenantId;
    }
  }
  if (!requestContext.authenticated && trustIdentityHeaders) {
    const tenantId = stableHeader(headerValue(request, 'x-tenant-id'), '');
    const userId = stableHeader(headerValue(request, 'x-user-id'), '');
    if (tenantId) requestContext.tenantId = tenantId;
    if (userId) requestContext.userId = userId;
    requestContext.authenticated = true;
  }
}
