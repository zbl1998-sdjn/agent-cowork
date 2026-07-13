// 模型调用韧性层:熔断 + 超时 + 多模型回退(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:把一次模型调用包上熔断器与超时控制,并在主模型不可用时按 fallbacks 顺序
//      回退到备用模型;区分"可回退"(超时/熔断/5xx)与"不可回退"(鉴权/4xx)错误;
//      对外暴露脱敏后的友好错误文案。
// 依赖:L0 security/redaction(脱敏)、同领域 model-breakers、provider/router(回退编排)。
// 导出:callModelResilient / friendlyAgentError / modelBreakerStats(再导出)
import { redactText } from '../../security/redaction.js';
import {
  decideEgressPolicy,
  enforceRecordedEgressDecision,
  recordEgressDecisionOrThrow,
} from '../../security/egress-gateway.js';
import { filterModelCandidatesBySecurityMode, modelProviderPolicyError } from '../../security/security-mode.js';
import { modelBreaker, modelBreakerStats, modelProvider } from '../model-breakers.js';
import { runWithFallback } from '../provider/router.js';
import { grantsTrustedInProcessModelCall, type TrustedInProcessModelCallCapability } from './model-call-capability.js';
import type { ModelCall, ModelCallArgs, ModelConfig } from './model-call-types.js';

export { modelBreakerStats };
export type { ModelCall, ModelCallArgs, ModelConfig } from './model-call-types.js';
type ModelError = Error & { code?: string; errors?: unknown[] };
type FallbackError = Error & { attempts?: Array<{ error: unknown }> };
type ResilienceOptions = {
  modelConfig?: unknown;
  inProcessModelCallCapability?: TrustedInProcessModelCallCapability;
  timeoutMs?: number;
  onFallback?: (event: { failed: unknown; next: unknown; error: string }) => void;
};

function objectConfig(value: unknown): ModelConfig {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ModelConfig : {};
}

function fallbackConfig(primary: unknown, fallback: unknown): ModelConfig {
  const source = objectConfig(fallback);
  const {
    apiKey: _apiKey, fallbacks: _fallbacks, provider: _provider, baseUrl: _baseUrl, model: _model, ...shared
  } = objectConfig(primary);
  const out: ModelConfig = { ...shared, ...source };
  if (!Object.prototype.hasOwnProperty.call(source, 'apiKey')) delete out.apiKey;
  delete out.fallbacks;
  return out;
}

function modelCandidates(modelConfig: unknown): ModelConfig[] {
  const primary = objectConfig(modelConfig);
  const fallbacks = Array.isArray(primary.fallbacks) ? primary.fallbacks : [];
  return [fallbackConfig(primary, primary), ...fallbacks.map((item) => fallbackConfig(primary, item))];
}

function modelSummary(modelConfig: unknown): { provider: string; baseUrl: unknown; model: unknown; hasKey: boolean } {
  const config = objectConfig(modelConfig);
  return {
    provider: modelProvider(config),
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.apiKey),
  };
}

function errorMessage(err: unknown): string {
  return (err as Partial<ModelError> | undefined)?.message || String(err || 'model call failed');
}

function shouldFallbackModelError(err: unknown): boolean {
  const error = err as Partial<ModelError> | undefined;
  if (error?.code === 'EGRESS_APPROVAL_REQUIRED'
    || error?.code === 'EGRESS_POLICY_DENIED'
    || error?.code === 'EGRESS_AUDIT_FAILED'
    || error?.code === 'MODEL_PROVIDER_POLICY_DENIED') return false;
  if (error?.code === 'CIRCUIT_OPEN') return true;
  if (error?.code === 'ETIMEDOUT') return true;
  const message = errorMessage(err);
  if (/\b(?:unauthorized|forbidden|invalid api key|api key|not configured)\b/i.test(message)) return false;
  if (/未配置/.test(message)) return false;
  const status = /\bstatus\s+(\d{3})\b/i.exec(message);
  if (status) {
    const code = Number(status[1]);
    if (code >= 400 && code < 500) return false;
  }
  return true;
}

function fallbackExhausted(errors: unknown[]): ModelError {
  const messages = errors.map((err) => redactText(errorMessage(err)));
  const agg = new Error(`all fallback layers failed: ${messages.join(' | ')}`) as ModelError;
  agg.name = 'FallbackExhaustedError';
  agg.code = 'FALLBACK_EXHAUSTED';
  agg.errors = errors;
  return agg;
}

async function callOneModel(modelCall: ModelCall, callArgs: ModelCallArgs, modelConfig: ModelConfig, timeoutMs: number, inProcess: boolean): Promise<unknown> {
  if (!inProcess) {
    const egress = decideEgressPolicy({
      kind: 'model_inference',
      provider: modelConfig.provider,
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      securityMode: modelConfig.securityMode,
      content: callArgs.messages,
      trustedRoot: callArgs.trustedRoot,
    });
    enforceRecordedEgressDecision(callArgs.trustedRoot, egress);
  }
  return modelBreaker(modelConfig).run(async () => {
    const controller = new AbortController();
    const upstreamSignal = callArgs && callArgs.signal;
    const abortFromUpstream = () => {
      if (!controller.signal.aborted) controller.abort(upstreamSignal && upstreamSignal.reason);
    };
    if (upstreamSignal) {
      if (upstreamSignal.aborted) abortFromUpstream();
      else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || 60000));
    try {
      return await modelCall({ ...callArgs, modelConfig, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (upstreamSignal) upstreamSignal.removeEventListener('abort', abortFromUpstream);
    }
  });
}

/** 带韧性地调用模型:单候选直连,多候选则按回退链逐个尝试,全失败时抛聚合错误。 */
export async function callModelResilient(
  modelCall: ModelCall,
  callArgs: ModelCallArgs,
  { modelConfig, inProcessModelCallCapability, timeoutMs = 60000, onFallback }: ResilienceOptions = {},
): Promise<unknown> {
  const candidates = modelCandidates(modelConfig);
  const inProcess = grantsTrustedInProcessModelCall(inProcessModelCallCapability, modelCall);
  const governed = inProcess ? [] : candidates;
  const policy = filterModelCandidatesBySecurityMode(governed, {
    securityMode: objectConfig(modelConfig).securityMode,
  });
  if (!inProcess) {
    for (const denied of policy.denied) {
      const candidate = denied.config as ModelConfig;
      const decision = decideEgressPolicy({
        kind: 'model_inference',
        provider: candidate.provider,
        model: candidate.model,
        baseUrl: candidate.baseUrl,
        securityMode: candidate.securityMode,
        content: callArgs.messages,
        trustedRoot: callArgs.trustedRoot,
      });
      recordEgressDecisionOrThrow(callArgs.trustedRoot, decision);
    }
  }
  const runnable = inProcess ? candidates : policy.candidates;
  if (runnable.length === 0) {
    throw modelProviderPolicyError(policy.denied);
  }
  if (runnable.length <= 1) return callOneModel(modelCall, callArgs, runnable[0] as ModelConfig, timeoutMs, inProcess);
  try {
    const routed = await runWithFallback(runnable, (candidate) => (
      callOneModel(modelCall, callArgs, candidate as ModelConfig, timeoutMs, inProcess)
    ), {
      shouldFallback: (err) => shouldFallbackModelError(err),
      onFallback: ({ failed, next, error }) => {
        if (typeof onFallback === 'function') {
          onFallback({
            failed: modelSummary(failed),
            next: modelSummary(next),
            error: String(redactText(errorMessage(error)) || ''),
          });
        }
      },
    });
    return routed.result;
  } catch (err) {
    const error: Partial<FallbackError> = err && typeof err === 'object' ? err as FallbackError : {};
    if (Array.isArray(error.attempts)) {
      throw fallbackExhausted(error.attempts.map((attempt) => new Error(String(attempt.error))));
    }
    throw err;
  }
}

/** 把底层模型错误转成面向用户的中文友好文案(熔断/超时各有专属提示,均附追踪号)。 */
export function friendlyAgentError(err: unknown, context: { traceId?: unknown } = {}): string {
  const trace = context && context.traceId ? `（追踪号 ${context.traceId}）` : '';
  const error = err as Partial<ModelError> | undefined;
  if (error?.code === 'CIRCUIT_OPEN') return `模型服务暂时不可用，已启用熔断保护，请稍后重试${trace}`;
  if (error?.code === 'ETIMEDOUT') return `模型响应超时，请稍后重试${trace}`;
  // 连接失败(本地模型没起/baseUrl 错/网络不通):Node fetch 抛 "fetch failed",cause.code
  // 常见 ECONNREFUSED/ENOTFOUND。给可操作提示,避免用户只看到晦涩的 "fetch failed"。
  const rawMsg = String(error?.message || '');
  const causeCode = String((error as { cause?: { code?: unknown } } | undefined)?.cause?.code || '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(rawMsg) || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(causeCode)) {
    return `无法连接模型服务:请确认本地模型(Ollama / LM Studio)正在运行、baseUrl 正确、网络可达后重试${trace}`;
  }
  const msg = redactText(error?.message || '发生未知错误');
  return `${msg}${trace ? ' ' + trace : ''}`;
}
