// FallbackEngine(host · L2 运行时)
// ---------------------------------------------------------------------------
// 职责:把模型、沙箱、依赖、缓存等运行状态归一成用户可见的降级决策。只描述
//       "当前能怎么继续",不直接执行重试、安装或切模型。
import { getSafeCacheTelemetry, type SafeCacheTelemetry } from '../engine/cache-telemetry.js';
import type { RuntimeDependencyStatus, RuntimeDependencyStatusItem } from './dependencies.js';

export type FallbackCause =
  | 'model_auth_failed'
  | 'memory_disabled'
  | 'dependency_missing'
  | 'sandbox_unavailable'
  | 'cache_corrupt'
  | 'context_over_budget';

export type FallbackDecision = {
  cause: FallbackCause;
  severity: 'info' | 'warning' | 'critical';
  mode: 'continue' | 'degrade' | 'pause_for_user' | 'abort_safely';
  userMessage: string;
  technicalMessage: string;
  suggestedActions: Array<{
    id: string;
    label: string;
    kind: 'retry' | 'install' | 'configure' | 'open_settings' | 'switch_provider' | 'continue_degraded';
  }>;
  audit: boolean;
};

export type FallbackStatus = {
  ok: true;
  ability: 'full' | 'degraded' | 'local_only';
  generatedAt: string;
  decisions: FallbackDecision[];
  cache: SafeCacheTelemetry;
};

export type FallbackStatusOptions = {
  modelConfigured?: boolean;
  sandboxNetworkIsolated?: boolean;
  sandboxMessage?: string;
  memorySettings?: { enabled?: boolean; paused?: boolean; incognito?: boolean } | null;
  dependencies?: RuntimeDependencyStatus | null;
  now?: Date;
};

function missingOptionalDependencies(status: RuntimeDependencyStatus | null | undefined): RuntimeDependencyStatusItem[] {
  return (status?.dependencies || []).filter((item) => (
    !item.required
    && item.installMode === 'on-demand'
    && (item.status === 'missing' || item.status === 'degraded')
  ));
}

function modelDecision(configured: boolean): FallbackDecision | null {
  if (configured) return null;
  return {
    cause: 'model_auth_failed',
    severity: 'warning',
    mode: 'degrade',
    userMessage: '模型未配置或不可用,本地文件、记忆和人工计划仍可继续使用。',
    technicalMessage: 'agentModelConfig.configured=false',
    suggestedActions: [
      { id: 'configure-model', label: '配置模型', kind: 'open_settings' },
      { id: 'continue-local', label: '继续本地计划', kind: 'continue_degraded' },
    ],
    audit: true,
  };
}

function memoryDecision(settings: FallbackStatusOptions['memorySettings']): FallbackDecision | null {
  if (!settings || (settings.enabled !== false && !settings.paused && !settings.incognito)) return null;
  return {
    cause: 'memory_disabled',
    severity: 'info',
    mode: 'continue',
    userMessage: settings.incognito ? '当前为隐身模式,不会读取或写入长期记忆。' : '记忆已暂停,本轮只使用当前窗口上下文。',
    technicalMessage: JSON.stringify(settings),
    suggestedActions: [{ id: 'open-memory-settings', label: '查看记忆设置', kind: 'open_settings' }],
    audit: false,
  };
}

function sandboxDecision(networkIsolated: boolean | undefined, detail = ''): FallbackDecision | null {
  if (networkIsolated) return null;
  return {
    cause: 'sandbox_unavailable',
    severity: 'warning',
    mode: 'degrade',
    userMessage: 'Docker/WSL 网络隔离不可用,工具执行会降级为本地模式,请谨慎批准命令。',
    technicalMessage: detail || 'sandbox network isolation unavailable',
    suggestedActions: [
      { id: 'configure-sandbox', label: '检查沙箱', kind: 'open_settings' },
      { id: 'continue-degraded-sandbox', label: '继续降级运行', kind: 'continue_degraded' },
    ],
    audit: true,
  };
}

function dependencyDecision(dependencies: RuntimeDependencyStatus | null | undefined): FallbackDecision | null {
  const missing = missingOptionalDependencies(dependencies);
  if (!missing.length) return null;
  const labels = missing.slice(0, 3).map((item) => item.label).join('、');
  return {
    cause: 'dependency_missing',
    severity: 'info',
    mode: 'continue',
    userMessage: `部分按需能力未安装:${labels}${missing.length > 3 ? '…' : ''};相关任务会使用低能力实现或提示安装计划。`,
    technicalMessage: missing.map((item) => `${item.id}:${item.status}`).join(','),
    suggestedActions: [{ id: 'install-plan', label: '查看安装计划', kind: 'install' }],
    audit: false,
  };
}

function cacheDecision(cache: SafeCacheTelemetry): FallbackDecision | null {
  if (cache.prefixStable !== false) return null;
  return {
    cause: 'cache_corrupt',
    severity: 'info',
    mode: 'continue',
    userMessage: '模型前缀缓存不稳定,本轮会继续执行,但后续任务可能较慢。',
    technicalMessage: `distinctPrefixes=${cache.distinctPrefixes}`,
    suggestedActions: [{ id: 'review-cache', label: '查看缓存状态', kind: 'open_settings' }],
    audit: false,
  };
}

export function buildFallbackStatus(options: FallbackStatusOptions = {}): FallbackStatus {
  const cache = getSafeCacheTelemetry();
  const decisions = [
    modelDecision(options.modelConfigured === true),
    memoryDecision(options.memorySettings),
    sandboxDecision(options.sandboxNetworkIsolated, options.sandboxMessage),
    dependencyDecision(options.dependencies),
    cacheDecision(cache),
  ].filter(Boolean) as FallbackDecision[];
  const ability = decisions.some((item) => item.cause === 'model_auth_failed')
    ? 'local_only'
    : decisions.some((item) => item.mode === 'degrade')
      ? 'degraded'
      : 'full';
  return {
    ok: true,
    ability,
    generatedAt: (options.now || new Date()).toISOString(),
    decisions,
    cache,
  };
}
