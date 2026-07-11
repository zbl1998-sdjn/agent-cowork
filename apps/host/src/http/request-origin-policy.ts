// HTTP Origin/Host 来源策略(host · L0 基础层 · http)
// ---------------------------------------------------------------------------
// 职责:集中判定请求来源是否可信 —— CORS Origin 白名单、Host 头白名单(防 DNS
//       rebinding),以及哪些请求需要做来源校验,供 HTTP 入口在处理前据此放行/拒绝。
// 依赖:无(纯函数)。导出:isLoopbackHostname, isAllowedOrigin, isAllowedHost, requiresOriginCheck。

/** 是否为回环主机名(localhost / 127.0.0.1 / ::1)。 */
export function isLoopbackHostname(hostname: unknown): boolean {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

const ALLOWED_BROWSER_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
]);

/**
 * CORS 来源白名单:无 Origin(同源/非浏览器)放行;浏览器允许产品/开发服务器的精确
 * Origin,以及与当前 Host 完全相同的 HTTP 回环 Origin。后者覆盖 host 自带 UI 的动态
 * 端口,但不会把其他回环端口一并提升为可信来源。
 */
export function isAllowedOrigin(origin: unknown, hostHeader?: unknown): boolean {
  const value = String(origin || '').trim();
  if (!value) return true;
  if (value === 'null') return false;
  try {
    const parsed = new URL(value);
    const canonical = parsed.protocol === 'tauri:'
      ? value.toLowerCase().replace(/\/$/u, '')
      : parsed.origin.toLowerCase();
    if (ALLOWED_BROWSER_ORIGINS.has(canonical)) return true;

    const requestHost = String(hostHeader || '').trim().toLowerCase();
    return parsed.protocol === 'http:'
      && isLoopbackHostname(parsed.hostname)
      && requestHost.length > 0
      && parsed.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

/** Host 头白名单(防 DNS rebinding):仅回环与 tauri.localhost 视为合法寻址本服务。 */
export function isAllowedHost(hostHeader: unknown): boolean {
  const value = String(hostHeader || '').trim();
  if (!value) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname) || hostname === 'tauri.localhost';
}

/** 是否需要做来源校验:/api/ 下的写方法(POST/PUT/PATCH/DELETE)才需要。 */
export function requiresOriginCheck(method: unknown, pathname: string): boolean {
  return pathname.startsWith('/api/')
    && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}
