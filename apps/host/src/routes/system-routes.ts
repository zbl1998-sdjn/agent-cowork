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
import { readMemorySettings } from '../memory/memory-control.js';
import { readEgressAuditRecords, summariseEgressAudit } from '../security/egress-audit.js';
import { buildTrustReport } from '../security/trust-report.js';
import {
  buildCapabilityInstallPlan,
  listCapabilityPacks,
  recommendCapabilityPacks,
} from '../runtime/capability-packs.js';
import {
  buildRuntimeDependencyCleanupPlan,
  buildRuntimeDependencyInstallPlan,
  buildRuntimeDependencyUpdatePlan,
} from '../runtime/dependency-install-plan.js';
import { buildFallbackStatus } from '../runtime/fallback-engine.js';
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
type ApprovalRegistryLike = { cancelByRun?: (runId: string, decision?: unknown) => number | Promise<number> };
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
  securityMode?: string;
  kimiApiEnabled?: boolean;
  sandboxEnabled?: boolean;
  sandbox?: SandboxLike | null;
  sandboxStartup?: SandboxStartupLike | null;
  storeBackend?: string;
  usePostgresState?: boolean;
  config: SystemRouteConfig;
  trustedRootDefault: string;
  cancellation: CancellationLike;
  approvalRegistry?: ApprovalRegistryLike | null;
};
export type SystemRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
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

function runtimeDependencyStatus(state: HostStateLike) {
  return getRuntimeDependencyStatus(omitUndefined({
    env: state.config.runtimeDependencyEnv || process.env,
    platform: state.config.runtimeDependencyPlatform || process.platform,
    sandboxStartup: state.sandboxStartup,
  }));
}

function safeMemorySettings(state: HostStateLike) {
  try {
    return readMemorySettings(state.trustedRootDefault);
  } catch {
    return null;
  }
}

export async function handleSystemRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  state,
}: SystemRouteOptions): Promise<boolean> {
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
    add('security-mode', true, state.securityMode || 'controlled_hybrid');
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
        mode: state.securityMode || 'controlled_hybrid',
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

  if (request.method === 'GET' && pathname === '/api/security/egress/summary') {
    const summary = summariseEgressAudit(readEgressAuditRecords(state.trustedRootDefault));
    sendJson(response, 200, { ok: true, summary, context: requestContext });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/security/trust-report') {
    sendJson(response, 200, {
      ok: true,
      report: buildTrustReport({
        trustedRoot: state.trustedRootDefault,
        securityMode: state.securityMode,
        modelConfig: state.kimiApiConfig as unknown as Record<string, unknown>,
        sandboxNetworkIsolated: Boolean(state.sandboxEnabled && state.sandbox && state.sandbox.networkIsolated),
      }),
      context: requestContext,
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/security/status') {
    const report = buildTrustReport({
      trustedRoot: state.trustedRootDefault,
      securityMode: state.securityMode,
      modelConfig: state.kimiApiConfig as unknown as Record<string, unknown>,
      sandboxNetworkIsolated: Boolean(state.sandboxEnabled && state.sandbox && state.sandbox.networkIsolated),
    });
    sendJson(response, 200, {
      ok: report.ok,
      securityMode: report.securityMode,
      model: report.model,
      egress: report.egress,
      checks: report.checks,
      context: requestContext,
    });
    return true;
  }

  if (request.method === 'GET' && (pathname === '/api/capabilities' || pathname === '/api/capabilities/catalog')) {
    sendJson(response, 200, { ok: true, packs: listCapabilityPacks(), context: requestContext });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/capabilities/recommend') {
    sendJson(response, 200, {
      ok: true,
      recommendations: recommendCapabilityPacks({
        role: requestUrl.searchParams.get('role') || undefined,
        taskIntent: requestUrl.searchParams.get('taskIntent') || undefined,
      }),
      context: requestContext,
    });
    return true;
  }

  if (request.method === 'POST' && (pathname === '/api/install/plan' || pathname === '/api/capabilities/install-plan')) {
    await withParsedDependencyPlanBody(request, response, 'invalid capability install plan request', (body) => {
      sendJson(response, 200, buildCapabilityInstallPlan(dependencyPlanOptions(body, state.config.runtimeDependencyAppDataRoot)));
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/fallback/status') {
    const dependencies = runtimeDependencyStatus(state);
    sendJson(response, 200, {
      ...buildFallbackStatus(omitUndefined({
        modelConfigured: state.kimiApiConfig.configured,
        sandboxNetworkIsolated: Boolean(state.sandboxEnabled && state.sandbox && state.sandbox.networkIsolated),
        sandboxMessage: state.sandboxStartup?.info?.userMessage,
        memorySettings: safeMemorySettings(state),
        dependencies,
      })),
      dependencies,
      context: requestContext,
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/runtime/dependencies') {
    sendJson(response, 200, runtimeDependencyStatus(state));
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
      securityMode: state.securityMode || 'controlled_hybrid',
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
    const cancelled = state.cancellation.cancel(id);
    // 取消必须同时吊销该 run 的待决审批:否则审批 await 吊死 SSE 流,
    // 且取消后点到残留审批按钮仍会真实执行高危工具(P1)。
    const registry = state.approvalRegistry;
    const revokedApprovals = registry && typeof registry.cancelByRun === 'function'
      ? Number(await registry.cancelByRun(id)) || 0
      : 0;
    sendJson(response, 200, { context: requestContext, runId: id, cancelled, revokedApprovals });
    return true;
  }
  return false;
}
