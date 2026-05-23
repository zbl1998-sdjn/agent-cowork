// web.fetch — a deliberate outbound HTTP tool for "research" tasks.
//
// Unlike the sandbox (network off by default), this is an explicit networked
// capability: callers ask for a URL and get back a size-capped text body. It
// validates the scheme, enforces a timeout and byte cap, and (by default) blocks
// obvious internal/loopback hosts to avoid trivially fetching the host itself.

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const BLOCKED_HOST_RE = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1|\[::1\])/i;

function fail(message, statusCode = 400) {
  const error = new Error(`web.fetch: ${message}`);
  error.statusCode = statusCode;
  return error;
}

export async function webFetch({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  allowInternal = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw fail('no fetch implementation available', 500);
  }
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw fail('invalid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail('only http(s) urls are allowed');
  }
  if (!allowInternal && BLOCKED_HOST_RE.test(parsed.hostname)) {
    throw fail(`host "${parsed.hostname}" is blocked (internal/loopback)`);
  }

  const budget = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), 60_000);
  const cap = Math.min(Math.max(Number(maxBytes) || DEFAULT_MAX_BYTES, 1), 4 * 1024 * 1024);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let response;
  try {
    response = await fetchImpl(parsed.href, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    throw fail(`request failed: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const contentType = (response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-type')
    : '') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  const truncated = buffer.length > cap;
  return {
    ok: Boolean(response.ok),
    status: response.status,
    url: parsed.href,
    contentType,
    bytes: buffer.length,
    truncated,
    text: buffer.subarray(0, cap).toString('utf8'),
  };
}
