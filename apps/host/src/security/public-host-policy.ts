// 公开 Host 入口安全策略(host · L0 纯策略)
// ---------------------------------------------------------------------------
// 职责:统一约束公开启动入口仅绑定回环地址,并强制认证、Host 校验和不信任身份头。
// 依赖:L0 http/request-origin-policy 的纯主机名判定;不依赖 runtime/server 等高层模块。
import { isLoopbackHostname } from '../http/request-origin-policy.js';

export type PublicHostSecurityConfig = {
  requireAuth: true;
  validateHost: true;
  trustIdentityHeaders: false;
};

export const PUBLIC_HOST_SECURITY: Readonly<PublicHostSecurityConfig> =
  Object.freeze({
    requireAuth: true,
    validateHost: true,
    trustIdentityHeaders: false,
  });

export function resolvePublicHost(host: string | undefined): string {
  const candidate = host === undefined ? '127.0.0.1' : host.trim();
  if (!isLoopbackHostname(candidate)) {
    throw new Error(
      '[host] refusing non-loopback HOST "' + candidate
        + '"; remote serving is not a supported security mode',
    );
  }
  return candidate === '[::1]' ? '::1' : candidate;
}

export function withPublicHostSecurity<T extends object>(
  config: T,
): Omit<T, keyof PublicHostSecurityConfig> & PublicHostSecurityConfig {
  return {
    ...config,
    ...PUBLIC_HOST_SECURITY,
  };
}
