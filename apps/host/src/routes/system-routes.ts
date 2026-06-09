// 系统路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理系统类端点 —— 健康检查、指标、熔断器/限流状态、运行时依赖探测、能力开关等运维可见性。
// 依赖:L2 runtime 各状态源(model-breakers/dependencies 等,经 state 注入)。导出:handleSystemRoutes。
import { modelBreakerStats } from '../runtime/model-breakers.js';
import { sendJson } from '../http/request-utils.js';
import { SECURITY_HEADERS } from '../http/middleware/common.js';
import { omitUndefined } from '../util/object.js';
import { readDesktopUpdateManifest } from '../runtime/desktop-update-source.js';
import { getRuntimeDependencyStatus } from '../runtime/dependencies.js';
import {
  buildRuntimeDependencyCleanupPlan,
  buildRuntimeDependencyInstallPlan,
  buildRuntimeDependencyUpdatePlan,
} from '../runtime/dependency-install-plan.js';
import {
  dependencyPlanOptions,
  parseCancelRunId,
  parseDesktopUpdateParams,
  withParsedDependencyPlanBody,
} from './system-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { KimiApiConfig } from '../kimi/api-runner-config.js';
import type { CircuitBreakerStats } from '../runtime/circuit-breaker.js';

type RouteRequest = HttpRequestLike & { method?: string };
type ConcurrencyStats = { active: number; maxConcurrent: number; tenants: number; [key: string]: unknown };
type RateLimitStats = { tenants: number; ratePerSec?: unknown; burst?: unknown; [key: string]: unknown };
type AgentConcurrencyLike = { stats(): ConcurrencyStats };
type RateLimiterLike = { stats(): RateLimitStats };
type CancellationLike = { cancel(id: string): boolean };
type SystemRequestContext = {
  traceId: string;
  tenantId: string;
  userId: string;
  authenticated?: boolean;
  idempotencyKey?: string;
};
type KimiApiConfigLike = Pick<KimiApiConfig, 'configured' | 'apiKey' | 'provider' | 'baseUrl' | 'model'>;
type SandboxLike = { backend?: string; networkIsolated?: boolean };
type SandboxStartupLike = {
  info?: { backend?: string; networkIsolated?: boolean; userMessage?: string; [key: string]: unknown };
};
type SystemRouteConfig = {
  runtimeDependencyEnv?: Record<string, string | undefined>;
  runtimeDependencyPlatform?: string;
  runtimeDependencyAppDataRoot?: string | null;
  desktopUpdateEnv?: Record<string, string | undefined>;
};
type SelfCheck = { id: string; status: 'pass' | 'warn'; detail: unknown };
type HostStateLike = {
  agentConcurrency: AgentConcurrencyLike;
  rateLimiter?: RateLimiterLike | null;
  draining?: boolean;
  kimiApiConfig: KimiApiConfigLike;
  kimiApiEnabled?: boolean;
  sandboxEnabled?: boolean;
  sandbox?: SandboxLike | null;
  sandboxStartup?: SandboxStartupLike | null;
  storeBackend?: string;
  usePostgresState?: boolean;
  config: SystemRouteConfig;
  trustedRootDefault: string;
  cancellation: CancellationLike;
};
export type SystemRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: SystemRequestContext;
  state: HostStateLike;
};

function modelProvider(kimiConfig: KimiApiConfigLike | null | undefined): string {
  return String((kimiConfig && kimiConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

function safeModelBreakerStats(): CircuitBreakerStats[] {
  try {
    return modelBreakerStats();
  } catch {
    return [];
  }
}

export async function handleSystemRoutes({ request, response, pathname, requestContext, state }: SystemRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'agent-cowork-host' });
    return true;
  }

  const updateMatch = /^\/desktop-update\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (request.method === 'GET' && updateMatch) {
    const params = parseDesktopUpdateParams(response, updateMatch);
    if (!params) return true;
    const manifest = readDesktopUpdateManifest({
      env: state.config.desktopUpdateEnv || process.env,
      target: params.target,
      arch: params.arch,
      currentVersion: params.currentVersion,
    });
    if (!manifest) {
      response.writeHead(204, SECURITY_HEADERS);
      response.end();
    } else {
      sendJson(response, 200, manifest);
    }
    return true;
  }

  if (request.method === 'GET' && pathname === '/metrics') {
    // 收口:运维指标默认不暴露,需显式设置 KCW_METRICS_ENABLED=true 才开启。这样既能在
    // 需要时供 Prometheus 抓取(像 /health 一样豁免鉴权),默认又不向任何本地调用方匿名
    // 泄露运行指标(进程内存、并发、熔断器等)。
    if (process.env.KCW_METRICS_ENABLED !== 'true') {
      response.writeHead(404, SECURITY_HEADERS);
      response.end();
      return true;
    }
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
    const rateLimitStats = state.rateLimiter ? state.rateLimiter.stats() : null;
    const rateLimit = rateLimitStats ? { enabled: true, ...rateLimitStats } : { enabled: false };
    const checks: SelfCheck[] = [];
    const add = (id: string, ok: boolean, detail: unknown): void => {
      checks.push({ id, status: ok ? 'pass' : 'warn', detail });
    };
    add('security-headers', true, Object.keys(SECURITY_HEADERS).join(', '));
    add('cors-loopback-only', true, 'only loopback http/https + tauri: origins reflected');
    add('api-key', state.kimiApiConfig.configured, state.kimiApiConfig.configured ? 'configured (never echoed)' : '未配置 API Key');
    add('rate-limit', Boolean(rateLimitStats), rateLimitStats ? `${rateLimitStats.ratePerSec}/s · burst ${rateLimitStats.burst}` : '限流未启用');
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
    sendJson(response, 200, getRuntimeDependencyStatus(omitUndefined({
      env: state.config.runtimeDependencyEnv || process.env,
      platform: state.config.runtimeDependencyPlatform || process.platform,
      sandboxStartup: state.sandboxStartup,
    })));
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/runtime/dependencies/install-plan') {
    await withParsedDependencyPlanBody(request, response, 'invalid runtime dependency install plan request', (body) => {
      sendJson(response, 200, buildRuntimeDependencyInstallPlan(dependencyPlanOptions(body, state.config.runtimeDependencyAppDataRoot)));
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/runtime/dependencies/cleanup-plan') {
    await withParsedDependencyPlanBody(request, response, 'invalid runtime dependency cleanup plan request', (body) => {
      sendJson(response, 200, buildRuntimeDependencyCleanupPlan(dependencyPlanOptions(body, state.config.runtimeDependencyAppDataRoot)));
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/runtime/dependencies/update-plan') {
    await withParsedDependencyPlanBody(request, response, 'invalid runtime dependency update plan request', (body) => {
      sendJson(response, 200, buildRuntimeDependencyUpdatePlan(dependencyPlanOptions(body, state.config.runtimeDependencyAppDataRoot)));
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

  const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(pathname);
  if (request.method === 'POST' && cancelMatch) {
    const id = parseCancelRunId(response, cancelMatch[1] ?? '');
    if (!id) return true;
    sendJson(response, 200, { context: requestContext, runId: id, cancelled: state.cancellation.cancel(id) });
    return true;
  }
  return false;
}
