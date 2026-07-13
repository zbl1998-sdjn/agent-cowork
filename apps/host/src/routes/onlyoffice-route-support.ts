// ONLYOFFICE 路由支持(host · L3 routes)
// 职责:隔离 Document Server 健康探测、回调 JWT 解包及受限文件下载。
import type { OnlyOfficeConfig } from '../artifacts/onlyoffice-config.js';
import { onlyOfficeBearerToken, verifyOnlyOfficeJwt } from '../artifacts/onlyoffice-jwt.js';
import { headerValue, type HttpRequestLike } from '../http/request-utils.js';

type SupportOptions = { config: OnlyOfficeConfig; fetchImpl: typeof fetch };

export async function probeOnlyOffice(
  { config, fetchImpl }: SupportOptions,
): Promise<{ healthy: boolean; detail: string }> {
  if (!config.configured) return { healthy: false, detail: config.enabled ? 'configuration-incomplete' : 'disabled' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.fetchTimeoutMs, 5_000));
  try {
    const response = await fetchImpl(`${config.documentServerUrl}/healthcheck`, {
      signal: controller.signal,
      redirect: 'error',
    });
    return { healthy: response.ok, detail: response.ok ? 'ok' : `http-${response.status}` };
  } catch (error) {
    return { healthy: false, detail: (error as Error).name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

export function verifyOnlyOfficeCallback({
  request,
  config,
  body,
}: { request: HttpRequestLike; config: OnlyOfficeConfig; body: unknown }): Record<string, unknown> {
  const token = onlyOfficeBearerToken(headerValue(request, config.jwtHeader));
  let verified: Record<string, unknown>;
  try { verified = verifyOnlyOfficeJwt(token, config.jwtSecret); }
  catch (error) { throw Object.assign(new Error((error as Error).message), { statusCode: 403 }); }
  const payload = verified.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('ONLYOFFICE callback JWT payload is invalid'), { statusCode: 403 });
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const opened = body as Record<string, unknown>;
    for (const key of ['key', 'status', 'url', 'filetype']) {
      if (opened[key] !== undefined && opened[key] !== (payload as Record<string, unknown>)[key]) {
        throw Object.assign(new Error(`ONLYOFFICE callback ${key} does not match its JWT`), { statusCode: 403 });
      }
    }
  }
  return payload as Record<string, unknown>;
}

export async function fetchOnlyOfficeFile(
  url: string,
  { config, fetchImpl }: SupportOptions,
): Promise<Buffer> {
  if (new URL(url).origin !== new URL(config.documentServerUrl).origin) {
    throw new Error('ONLYOFFICE callback download URL origin is not allowed');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`ONLYOFFICE download returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > config.maxFileBytes) throw new Error('ONLYOFFICE saved file exceeds the configured limit');
    if (!response.body) throw new Error('ONLYOFFICE download response has no body');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > config.maxFileBytes) {
        await reader.cancel();
        throw new Error('ONLYOFFICE saved file exceeds the configured limit');
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
