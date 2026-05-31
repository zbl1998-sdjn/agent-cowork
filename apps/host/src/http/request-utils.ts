// HTTP 请求/响应工具箱(host · L0 基础层,无内部依赖)
// ---------------------------------------------------------------------------
// 职责:为路由层提供与具体框架解耦的底层原语——JSON 响应、请求体读取(含 DoS 限额)、
//       CORS/Host 同源校验(防 DNS rebinding)、请求上下文构造、幂等指纹等。
// 安全:tenant/user 身份「绝不」信任客户端请求头(见 createRequestContext);
//       写操作走 requiresOriginCheck + isAllowedOrigin 双闸门。
// 导出:sendJson / withJsonBody / readJsonBody / createRequestContext / isAllowedOrigin
//       / isAllowedHost / bodyFingerprint / sendFile 等。
import crypto from 'node:crypto';
import fs from 'node:fs';

export {
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackHostname,
  requiresOriginCheck,
} from './request-origin-policy.js';

export type HttpResponseLike = {
  writeHead(statusCode: number, headers?: Record<string, string | number>): unknown;
  end(chunk?: string | Buffer): unknown;
};
export type HttpRequestLike = {
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  resume?: () => unknown;
};
export type HttpError = Error & { statusCode?: number; payload?: Record<string, unknown> };
export type JsonBodyOptions = { requireJsonContentType?: boolean; maxBytes?: number };
export type RequestContext = {
  traceId: string;
  tenantId: string;
  userId: string;
  authenticated: boolean;
  idempotencyKey: string;
};

/** 以 JSON 响应:序列化 payload 并写好 content-type 与 content-length。 */
export function sendJson(response: HttpResponseLike, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** 取请求头(大小写不敏感);多值时取第一个。 */
export function headerValue(request: HttpRequestLike, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** 校验并清洗头部值:仅允许有限字符集与长度,非法则回退 fallback(防注入)。 */
export function stableHeader(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9_.:-]{1,96}$/.test(text) ? text : fallback;
}

/** 请求体是否声明为 application/json。 */
export function isJsonContentType(request: HttpRequestLike): boolean {
  const value = String(headerValue(request, 'content-type') || '').toLowerCase();
  return value.split(';')[0].trim() === 'application/json';
}

/** 稳定序列化:对象键按字典序排序,使「相同内容」总得到相同字符串(用于指纹/幂等)。 */
export function stableJsonStringify(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const encoded = stableJsonStringify(record[key]);
        return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter((entry): entry is string => Boolean(entry));
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 请求体的 SHA-256 指纹(基于稳定序列化),用于幂等键去重。 */
export function bodyFingerprint(body: unknown): string {
  return crypto
    .createHash('sha256')
    .update(stableJsonStringify(body ?? {}) || '{}')
    .digest('hex');
}

/**
 * 构造请求上下文:traceId、租户/用户身份、是否已认证、幂等键。
 * 安全要点:tenant/user 一律从本地身份起步,「只」由后续验证过的会话/JWT 覆写,绝不取自请求头。
 */
export function createRequestContext(request: HttpRequestLike): RequestContext {
  const traceId = stableHeader(headerValue(request, 'x-trace-id'), `trace_${crypto.randomUUID()}`);
  return {
    traceId,
    // SECURITY: tenant/user are NOT read from client headers (those are
    // spoofable — trusting them let any caller impersonate any tenant). They
    // start as the local identity and are overwritten ONLY by a verified
    // session/JWT in the request entry. `authenticated` then gates /api/*.
    tenantId: 'tenant_local',
    userId: 'user_local',
    authenticated: false,
    idempotencyKey: stableHeader(headerValue(request, 'idempotency-key'), ''),
  };
}

/** 安全地 decodeURIComponent 路径段;非法编码返回 null 而非抛错。 */
export function decodePathSegment(value: unknown): string | null {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return null;
  }
}

/** 同步读取并直出文件(no-store);读失败返回 404 JSON。 */
export function sendFile(response: HttpResponseLike, filePath: string, contentType: string): void {
  try {
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (err) {
    const error = err as { message?: string };
    sendJson(response, 404, { error: `Static asset not found: ${error.message}` });
  }
}

/**
 * 读取并解析 JSON 请求体;超过 maxBytes 抛 413(DoS 防护:暂停并丢弃后续分块,内存有界)。
 */
export function readJsonBody(request: HttpRequestLike, { maxBytes = 1024 * 1024 }: { maxBytes?: number } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer | string) => {
      if (rejected) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        rejected = true;
        // DoS guard: refuse oversized bodies. Pause (don't destroy yet) so the
        // caller can send a clear 413 response FIRST — Node then closes the
        // socket once the response finishes with the body still unread, instead
        // of the client seeing a bare connection reset.
        const err = new Error(`Request body too large; max ${maxBytes} bytes`) as HttpError;
        err.statusCode = 413;
        // Drain & DISCARD the rest (don't buffer it) so the caller can send a
        // clean 413 and the connection closes normally — the client gets a real
        // status code instead of a connection reset. Subsequent chunks hit the
        // `rejected` guard above and are dropped, so memory stays bounded.
        if (typeof request.resume === 'function') request.resume();
        reject(err);
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      if (rejected) {
        return;
      }
      const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on('error', reject);
  });
}

/**
 * 路由处理的便捷包装:校验 content-type、读 JSON 体并交给 handler;统一把错误转成
 * 415/413/400 等 JSON 响应(handler 内抛的带 statusCode 的错误也会被规范化)。
 */
export async function withJsonBody(
  request: HttpRequestLike,
  response: HttpResponseLike,
  handler: (body: unknown) => void | Promise<void>,
  options: JsonBodyOptions = {},
): Promise<void> {
  if (options.requireJsonContentType !== false && !isJsonContentType(request)) {
    sendJson(response, 415, { error: 'content-type must be application/json' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(request, options);
  } catch (err) {
    // 413 for oversized bodies, 400 for malformed JSON.
    const httpErr = err as Partial<HttpError>;
    sendJson(response, httpErr.statusCode || 400, { error: `Invalid JSON body: ${httpErr.message}` });
    return;
  }
  try {
    await handler(body);
  } catch (err) {
    const httpErr = err as Partial<HttpError>;
    sendJson(response, httpErr.statusCode || 400, {
      error: httpErr.message,
      ...(httpErr.payload || {}),
    });
  }
}
