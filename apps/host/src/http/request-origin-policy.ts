// HTTP Origin/Host 策略(host · L0 基础层):集中处理 CORS 与 DNS rebinding 防护。

/** 是否为回环主机名(localhost / 127.0.0.1 / ::1)。 */
export function isLoopbackHostname(hostname: unknown): boolean {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

/** CORS 来源白名单:无 Origin(同源/非浏览器)放行,回环与 Tauri webview 放行,其余拒绝。 */
export function isAllowedOrigin(origin: unknown): boolean {
  const value = String(origin || '').trim();
  if (!value) return true;
  if (value === 'null') return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'tauri:') return true;
    const host = String(parsed.hostname || '').toLowerCase();
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (isLoopbackHostname(host) || host === 'tauri.localhost');
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
