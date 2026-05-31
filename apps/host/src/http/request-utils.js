// @ts-check
//
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

/** @typedef {{ writeHead(statusCode: number, headers?: Record<string, string | number>): unknown, end(chunk?: string | Buffer): unknown }} HttpResponseLike */
/** @typedef {{ headers: Record<string, string | string[] | undefined>, on(event: string, listener: (...args: any[]) => void): unknown, resume?: () => unknown }} HttpRequestLike */
/** @typedef {Error & { statusCode?: number, payload?: Record<string, unknown> }} HttpError */
/** @typedef {{ requireJsonContentType?: boolean, maxBytes?: number }} JsonBodyOptions */

/** 以 JSON 响应:序列化 payload 并写好 content-type 与 content-length。 @param {HttpResponseLike} response @param {number} status @param {unknown} payload */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** 取请求头(大小写不敏感);多值时取第一个。 @param {HttpRequestLike} request @param {string} name @returns {string | undefined} */
export function headerValue(request, name) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** 校验并清洗头部值:仅允许有限字符集与长度,非法则回退 fallback(防注入)。 @param {unknown} value @param {string} fallback @returns {string} */
export function stableHeader(value, fallback) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9_.:-]{1,96}$/.test(text) ? text : fallback;
}

/** 请求体是否声明为 application/json。 @param {HttpRequestLike} request @returns {boolean} */
export function isJsonContentType(request) {
  const value = String(headerValue(request, 'content-type') || '').toLowerCase();
  return value.split(';')[0].trim() === 'application/json';
}

/** 是否为回环主机名(localhost / 127.0.0.1 / ::1)。 @param {unknown} hostname @returns {boolean} */
export function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

/** CORS 来源白名单:无 Origin(同源/非浏览器)放行,回环与 Tauri webview 放行,其余拒绝。 @param {unknown} origin @returns {boolean} */
export function isAllowedOrigin(origin) {
  const value = String(origin || '').trim();
  // No Origin header = same-origin navigation or a non-browser client (curl, the
  // desktop host itself) — allowed. The literal opaque origin "null" (sandboxed
  // iframe, file://, data:) is NOT allowed: it can't be attributed to a trusted
  // loopback/tauri context, so we never reflect CORS for it.
  if (!value) {
    return true;
  }
  if (value === 'null') {
    return false;
  }
  try {
    const parsed = new URL(value);
    // Tauri webview origins: `tauri://localhost` (macOS/Linux) and, on Windows,
    // the custom-protocol origin surfaces as http(s)://tauri.localhost. Both are
    // the desktop shell itself and must be allowed, otherwise the webview's
    // cross-origin calls to the loopback host (incl. CORS preflight) are blocked
    // and the app can't even log in.
    if (parsed.protocol === 'tauri:') {
      return true;
    }
    const host = String(parsed.hostname || '').toLowerCase();
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (isLoopbackHostname(host) || host === 'tauri.localhost');
  } catch {
    return false;
  }
}

/** Host 头白名单(防 DNS rebinding):仅回环与 tauri.localhost 视为合法寻址本服务。 @param {unknown} hostHeader @returns {boolean} */
export function isAllowedHost(hostHeader) {
  const value = String(hostHeader || '').trim();
  // No Host header = HTTP/1.0 or a non-browser client; not a DNS-rebinding vector,
  // so we don't block it (the loopback bind already scopes who can reach us).
  if (!value) {
    return true;
  }
  let hostname;
  try {
    hostname = new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Anti-DNS-rebinding: a malicious site that rebinds its name to 127.0.0.1 still
  // sends its own name in the Host header. Only the loopback host / tauri webview
  // are legitimate ways to address this server.
  return isLoopbackHostname(hostname) || hostname === 'tauri.localhost';
}

/** 是否需要做来源校验:/api/ 下的写方法(POST/PUT/PATCH/DELETE)才需要。 @param {unknown} method @param {string} pathname @returns {boolean} */
export function requiresOriginCheck(method, pathname) {
  return pathname.startsWith('/api/')
    && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

/** 稳定序列化:对象键按字典序排序,使「相同内容」总得到相同字符串(用于指纹/幂等)。 @param {unknown} value @returns {string | undefined} */
export function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const encoded = stableJsonStringify(record[key]);
        return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter(Boolean);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 请求体的 SHA-256 指纹(基于稳定序列化),用于幂等键去重。 @param {unknown} body @returns {string} */
export function bodyFingerprint(body) {
  return crypto
    .createHash('sha256')
    .update(stableJsonStringify(body ?? {}) || '{}')
    .digest('hex');
}

/**
 * 构造请求上下文:traceId、租户/用户身份、是否已认证、幂等键。
 * 安全要点:tenant/user 一律从本地身份起步,「只」由后续验证过的会话/JWT 覆写,绝不取自请求头。
 * @param {HttpRequestLike} request @returns {{ traceId: string, tenantId: string, userId: string, authenticated: boolean, idempotencyKey: string }}
 */
export function createRequestContext(request) {
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

/** 安全地 decodeURIComponent 路径段;非法编码返回 null 而非抛错。 @param {unknown} value @returns {string | null} */
export function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return null;
  }
}

/** 同步读取并直出文件(no-store);读失败返回 404 JSON。 @param {HttpResponseLike} response @param {string} filePath @param {string} contentType */
export function sendFile(response, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (err) {
    const error = /** @type {{ message?: string }} */ (err);
    sendJson(response, 404, { error: `Static asset not found: ${error.message}` });
  }
}

/**
 * 读取并解析 JSON 请求体;超过 maxBytes 抛 413(DoS 防护:暂停并丢弃后续分块,内存有界)。
 * @param {HttpRequestLike} request @param {{ maxBytes?: number }} [options] @returns {Promise<unknown>}
 */
export function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    request.on('data', (chunk) => {
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
        const err = /** @type {HttpError} */ (new Error(`Request body too large; max ${maxBytes} bytes`));
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
 * @param {HttpRequestLike} request @param {HttpResponseLike} response @param {(body: unknown) => void | Promise<void>} handler @param {JsonBodyOptions} [options] @returns {Promise<void>}
 */
export async function withJsonBody(request, response, handler, options = {}) {
  if (options.requireJsonContentType !== false && !isJsonContentType(request)) {
    sendJson(response, 415, { error: 'content-type must be application/json' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(request, options);
  } catch (err) {
    // 413 for oversized bodies, 400 for malformed JSON.
    const httpErr = /** @type {Partial<HttpError>} */ (err);
    sendJson(response, httpErr.statusCode || 400, { error: `Invalid JSON body: ${httpErr.message}` });
    return;
  }
  try {
    await handler(body);
  } catch (err) {
    const httpErr = /** @type {Partial<HttpError>} */ (err);
    sendJson(response, httpErr.statusCode || 400, {
      error: httpErr.message,
      ...(httpErr.payload || {}),
    });
  }
}
