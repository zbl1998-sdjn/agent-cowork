import { modelBreakerStats } from '../kimi/agent-runner.js';
import { sendJson } from '../http/request-utils.js';
import { SECURITY_HEADERS } from '../http/middleware/common.js';

export async function handleSystemRoutes({ request, response, pathname, requestContext, state }) {
  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'agent-cowork-host' });
    return true;
  }

  if (request.method === 'GET' && pathname === '/metrics') {
    const c = state.agentConcurrency.stats();
    const rl = state.rateLimiter ? state.rateLimiter.stats() : { tenants: 0 };
    let breakers = [];
    try { breakers = modelBreakerStats(); } catch { breakers = []; }
    const openBreakers = breakers.filter((b) => b.state === 'open').length;
    const mem = process.memoryUsage();
    const body = [
      '# HELP kcw_uptime_seconds Host process uptime in seconds.',
      '# TYPE kcw_uptime_seconds gauge',
      `kcw_uptime_seconds ${Math.floor(process.uptime())}`,
      '# HELP kcw_concurrency_active Active agent streams.',
      '# TYPE kcw_concurrency_active gauge',
      `kcw_concurrency_active ${c.active}`,
      `kcw_concurrency_max ${c.maxConcurrent}`,
      `kcw_concurrency_tenants ${c.tenants}`,
      '# HELP kcw_ratelimit_tenants Tenants with an active rate-limit bucket.',
      '# TYPE kcw_ratelimit_tenants gauge',
      `kcw_ratelimit_tenants ${rl.tenants || 0}`,
      '# HELP kcw_model_breakers_open Open model circuit breakers.',
      '# TYPE kcw_model_breakers_open gauge',
      `kcw_model_breakers_open ${openBreakers}`,
      '# HELP kcw_draining Whether the host is draining for shutdown (1/0).',
      '# TYPE kcw_draining gauge',
      `kcw_draining ${state.draining ? 1 : 0}`,
      '# HELP process_resident_memory_bytes Resident set size in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${mem.rss}`,
      '',
    ].join('\n');
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', ...SECURITY_HEADERS });
    response.end(body);
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/selfcheck') {
    let breakers = [];
    try { breakers = modelBreakerStats(); } catch { breakers = []; }
    const rateLimit = state.rateLimiter ? { enabled: true, ...state.rateLimiter.stats() } : { enabled: false };
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, status: ok ? 'pass' : 'warn', detail });
    add('security-headers', true, Object.keys(SECURITY_HEADERS).join(', '));
    add('cors-loopback-only', true, 'only loopback http/https + tauri: origins reflected');
    add('api-key', state.kimiApiConfig.configured, state.kimiApiConfig.configured ? 'configured (never echoed)' : '未配置 API Key');
    add('rate-limit', Boolean(state.rateLimiter), state.rateLimiter ? `${rateLimit.ratePerSec}/s · burst ${rateLimit.burst}` : '限流未启用');
    add('model-circuit', !breakers.some((b) => b.state === 'open'), breakers.length ? breakers.map((b) => `${b.name}:${b.state}`).join(', ') : '尚无模型调用');
    add('accepting-requests', !state.draining, state.draining ? '正在优雅停机' : '正常受理请求');
    sendJson(response, 200, {
      service: 'agent-cowork-host',
      time: new Date().toISOString(),
      security: {
        responseHeaders: Object.keys(SECURITY_HEADERS),
        cors: 'loopback+tauri only',
        apiKey: { configured: state.kimiApiConfig.configured, hasKey: Boolean(state.kimiApiConfig.apiKey) },
        bodyLimitBytes: 1024 * 1024,
      },
      resilience: {
        rateLimit,
        concurrency: state.agentConcurrency.stats(),
        modelBreakers: breakers,
        draining: state.draining,
      },
      storage: { backend: state.storeBackend, postgres: state.usePostgresState },
      checks,
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/workspace') {
    sendJson(response, 200, {
      trustedRoot: state.trustedRootDefault,
      context: requestContext,
      kimiApi: {
        provider: 'kimi-api',
        configured: state.kimiApiConfig.configured,
        planEnabled: state.kimiApiEnabled,
        chatEnabled: state.kimiApiEnabled,
        baseUrl: state.kimiApiConfig.baseUrl,
        model: state.kimiApiConfig.model,
      },
      kimiCli: { planEnabled: false, chatEnabled: false, legacy: true },
    });
    return true;
  }

  if (request.method === 'POST' && /^\/api\/runs\/[a-zA-Z0-9_-]+\/cancel$/.test(pathname)) {
    const id = pathname.split('/')[3];
    sendJson(response, 200, { context: requestContext, runId: id, cancelled: state.cancellation.cancel(id) });
    return true;
  }
  return false;
}
