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
  if (!value || value === 'null') {
    return true;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'tauri:') {
      return true;
    }
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && isLoopbackHostname(parsed.hostname);
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
    tenantId: stableHeader(headerValue(request, 'x-tenant-id'), 'tenant_local'),
    userId: stableHeader(headerValue(request, 'x-user-id'), 'user_local'),
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
        reject(new Error(`Request body too large; max ${maxBytes} bytes`));
        request.destroy();
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
    sendJson(response, 400, { error: `Invalid JSON body: ${err.message}` });
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
