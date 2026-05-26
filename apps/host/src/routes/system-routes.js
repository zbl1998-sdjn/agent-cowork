import { modelBreakerStats } from '../runtime/model-breakers.js';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { SECURITY_HEADERS } from '../http/middleware/common.js';
import { getRuntimeDependencyStatus } from '../runtime/dependencies.js';
import {
  buildRuntimeDependencyCleanupPlan,
  buildRuntimeDependencyInstallPlan,
  buildRuntimeDependencyUpdatePlan,
} from '../runtime/dependency-install-plan.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {import('../http/middleware/common.js').RequestContext} RequestContext
 * @typedef {import('../runtime/dependency-install-plan.js').RuntimeDependencyInstallPlanOptions & import('../runtime/dependency-install-plan.js').RuntimeDependencyCleanupPlanOptions & import('../runtime/dependency-install-plan.js').RuntimeDependencyUpdatePlanOptions} RuntimeDependencyPlanOptions
 * @typedef {{ state?: string, name?: string }} ModelBreakerStats
 * @typedef {{ active?: number, maxConcurrent?: number, tenants?: number, [key: string]: unknown }} ConcurrencyStats
 * @typedef {{ tenants?: number, ratePerSec?: unknown, burst?: unknown, [key: string]: unknown }} RateLimitStats
 * @typedef {{ stats(): ConcurrencyStats }} AgentConcurrencyLike
 * @typedef {{ stats(): RateLimitStats }} RateLimiterLike
 * @typedef {{ cancel(id: string): boolean }} CancellationLike
 * @typedef {{ configured: boolean, apiKey?: unknown, provider?: unknown, baseUrl?: unknown, model?: unknown }} KimiApiConfigLike
 * @typedef {{ backend?: string, networkIsolated?: boolean }} SandboxLike
 * @typedef {{ info?: { backend?: string, networkIsolated?: boolean, userMessage?: string, [key: string]: unknown } }} SandboxStartupLike
 * @typedef {{
 *   agentConcurrency: AgentConcurrencyLike,
 *   rateLimiter?: RateLimiterLike | null,
 *   draining?: boolean,
 *   kimiApiConfig: KimiApiConfigLike,
 *   kimiApiEnabled?: boolean,
 *   sandboxEnabled?: boolean,
 *   sandbox?: SandboxLike | null,
 *   sandboxStartup?: SandboxStartupLike | null,
 *   storeBackend?: string,
 *   usePostgresState?: boolean,
 *   config: { runtimeDependencyEnv?: Record<string, string | undefined>, runtimeDependencyPlatform?: string, runtimeDependencyAppDataRoot?: string | null },
 *   trustedRootDefault: string,
 *   cancellation: CancellationLike,
 * }} HostStateLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: RequestContext, state: HostStateLike }} SystemRouteOptions
 */

/** @param {unknown} body @returns {Record<string, unknown>} */
function objectBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? /** @type {Record<string, unknown>} */ (body)
    : {};
}

/** @param {KimiApiConfigLike | null | undefined} kimiConfig @returns {string} */
function modelProvider(kimiConfig) {
  return String((kimiConfig && kimiConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

/** @param {unknown} body @param {HostStateLike} state @returns {RuntimeDependencyPlanOptions} */
function dependencyPlanOptions(body, state) {
  const input = objectBody(body);
  const appDataRoot = typeof input.appDataRoot === 'string'
    ? input.appDataRoot
    : state.config.runtimeDependencyAppDataRoot;
  return {
    selectedIds: Array.isArray(input.selectedIds) ? input.selectedIds : undefined,
    freeBytes: input.freeBytes,
    keepUserData: typeof input.keepUserData === 'boolean' ? input.keepUserData : undefined,
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
    appDataRoot,
  };
}

/** @returns {ModelBreakerStats[]} */
function safeModelBreakerStats() {
  try {
    return /** @type {ModelBreakerStats[]} */ (modelBreakerStats());
  } catch {
    return [];
  }
}

/** @param {SystemRouteOptions} options @returns {Promise<boolean>} */
export async function handleSystemRoutes({ request, response, pathname, requestContext, state }) {
  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'agent-cowork-host' });
    return true;
  }

  if (request.method === 'GET' && pathname === '/metrics') {
    const c = state.agentConcurrency.stats();
    const rl = state.rateLimiter ? state.rateLimiter.stats() : { tenants: 0 };
    const breakers = safeModelBreakerStats();
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
    const breakers = safeModelBreakerStats();
    const rateLimit = state.rateLimiter ? { enabled: true, ...state.rateLimiter.stats() } : { enabled: false };
    /** @type {Array<{ id: string, status: 'pass' | 'warn', detail: unknown }>} */
    const checks = [];
    /** @param {string} id @param {boolean} ok @param {unknown} detail */
    const add = (id, ok, detail) => checks.push({ id, status: ok ? 'pass' : 'warn', detail });
    add('security-headers', true, Object.keys(SECURITY_HEADERS).join(', '));
    add('cors-loopback-only', true, 'only loopback http/https + tauri: origins reflected');
    add('api-key', state.kimiApiConfig.configured, state.kimiApiConfig.configured ? 'configured (never echoed)' : '未配置 API Key');
    add('rate-limit', Boolean(state.rateLimiter), state.rateLimiter ? `${rateLimit.ratePerSec}/s · burst ${rateLimit.burst}` : '限流未启用');
    add('model-circuit', !breakers.some((b) => b.state === 'open'), breakers.length ? breakers.map((b) => `${b.name}:${b.state}`).join(', ') : '尚无模型调用');
    add(
      'sandbox-network-isolation',
      Boolean(state.sandboxEnabled && state.sandbox && state.sandbox.networkIsolated),
      state.sandboxStartup?.info?.userMessage || (state.sandbox?.networkIsolated ? '网络默认隔离' : '本地不隔离网络'),
    );
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
      sandbox: {
        enabled: Boolean(state.sandboxEnabled),
        backend: state.sandbox ? state.sandbox.backend : null,
        networkIsolated: state.sandbox ? Boolean(state.sandbox.networkIsolated) : false,
        startup: state.sandboxStartup?.info || null,
      },
      checks,
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/runtime/dependencies') {
    sendJson(response, 200, getRuntimeDependencyStatus({
      env: state.config.runtimeDependencyEnv || process.env,
      platform: state.config.runtimeDependencyPlatform || process.platform,
      sandboxStartup: state.sandboxStartup,
    }));
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/runtime/dependencies/install-plan') {
    await withJsonBody(request, response, (body) => {
      sendJson(response, 200, buildRuntimeDependencyInstallPlan(dependencyPlanOptions(body, state)));
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/runtime/dependencies/cleanup-plan') {
    await withJsonBody(request, response, (body) => {
      sendJson(response, 200, buildRuntimeDependencyCleanupPlan(dependencyPlanOptions(body, state)));
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/runtime/dependencies/update-plan') {
    await withJsonBody(request, response, (body) => {
      sendJson(response, 200, buildRuntimeDependencyUpdatePlan(dependencyPlanOptions(body, state)));
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/workspace') {
    sendJson(response, 200, {
      trustedRoot: state.trustedRootDefault,
      context: requestContext,
      kimiApi: {
        provider: modelProvider(state.kimiApiConfig),
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
