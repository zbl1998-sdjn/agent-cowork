import crypto from 'node:crypto';
import fs from 'node:fs';

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function headerValue(request, name) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function stableHeader(value, fallback) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9_.:-]{1,96}$/.test(text) ? text : fallback;
}

export function isJsonContentType(request) {
  const value = String(headerValue(request, 'content-type') || '').toLowerCase();
  return value.split(';')[0].trim() === 'application/json';
}

export function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

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

export function requiresOriginCheck(method, pathname) {
  return pathname.startsWith('/api/')
    && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

export function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const encoded = stableJsonStringify(value[key]);
        return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter(Boolean);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function bodyFingerprint(body) {
  return crypto
    .createHash('sha256')
    .update(stableJsonStringify(body ?? {}) || '{}')
    .digest('hex');
}

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

export function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

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
    sendJson(response, 404, { error: `Static asset not found: ${err.message}` });
  }
}

export function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
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
        const err = new Error(`Request body too large; max ${maxBytes} bytes`);
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
      const raw = chunks.length ? Buffer.concat(chunks, totalBytes).toString('utf8') : '';
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
    sendJson(response, err.statusCode || 400, { error: `Invalid JSON body: ${err.message}` });
    return;
  }
  try {
    await handler(body);
  } catch (err) {
    sendJson(response, err.statusCode || 400, {
      error: err.message,
      ...(err.payload || {}),
    });
  }
}
