// 请求身份附着(host · L1 领域层 · auth)
// ---------------------------------------------------------------------------
// 职责:从请求里「安全地」解析身份并写入 requestContext。仅认可 Bearer:先验 JWT、再查会话 token;
//       x-tenant-id/x-user-id 头默认「不信任」,仅当显式开启 trustIdentityHeaders(反代后)才采用。
// 安全:默认不信客户端身份头(防伪冒,见 http/request-utils 的说明)。依赖:L0 request-utils + 同层 jwt。
// 导出:attachRequestIdentity。
import { headerValue, stableHeader } from '../http/request-utils.js';
import type { HttpRequestLike, RequestContext } from '../http/request-utils.js';
import { resolveJwtIdentity } from './jwt.js';
import type { JwtIdentity } from './jwt.js';

type AuthStoreLike = {
  resolveToken(token: string): { userId?: string | null; tenantId?: string | null } | null;
};
type ResolvedIdentity = JwtIdentity | { userId?: string | null; tenantId?: string | null };
type AttachRequestIdentityOptions = {
  request: HttpRequestLike;
  requestContext: RequestContext;
  authStore: AuthStoreLike;
  jwtSecret?: string | null;
  trustIdentityHeaders?: boolean;
};

/** 解析并把身份写入 requestContext:Bearer(JWT 或会话 token)优先;仅 trustIdentityHeaders 时才采纳身份头。 */
export function attachRequestIdentity({
  request,
  requestContext,
  authStore,
  jwtSecret,
  trustIdentityHeaders,
}: AttachRequestIdentityOptions): void {
  const authHeader = headerValue(request, 'authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    let session: ResolvedIdentity | null = jwtSecret ? resolveJwtIdentity(token, jwtSecret) : null;
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
