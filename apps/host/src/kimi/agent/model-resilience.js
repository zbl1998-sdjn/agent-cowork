import { redactText } from '../../security/redaction.js';
import { modelBreaker, modelBreakerStats, modelProvider } from '../../runtime/model-breakers.js';
import { runWithFallback } from '../provider/router.js';

export { modelBreakerStats };

function fallbackConfig(primary, fallback) {
  const source = fallback && typeof fallback === 'object' ? fallback : {};
  const {
    apiKey: _apiKey, fallbacks: _fallbacks, provider: _provider, baseUrl: _baseUrl, model: _model, ...shared
  } = primary && typeof primary === 'object' ? primary : {};
  const out = { ...shared, ...source };
  if (!Object.prototype.hasOwnProperty.call(source, 'apiKey')) delete out.apiKey;
  delete out.fallbacks;
  return out;
}

function modelCandidates(kimiConfig) {
  const primary = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {};
  const fallbacks = Array.isArray(primary.fallbacks) ? primary.fallbacks : [];
  return [fallbackConfig(primary, primary), ...fallbacks.map((item) => fallbackConfig(primary, item))];
}

function modelSummary(kimiConfig) {
  return {
    provider: modelProvider(kimiConfig),
    baseUrl: kimiConfig && kimiConfig.baseUrl,
    model: kimiConfig && kimiConfig.model,
    hasKey: Boolean(kimiConfig && kimiConfig.apiKey),
  };
}

function errorMessage(err) {
  return (err && err.message) || String(err || 'model call failed');
}

function shouldFallbackModelError(err) {
  if (err && err.code === 'CIRCUIT_OPEN') return true;
  if (err && err.code === 'ETIMEDOUT') return true;
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

function fallbackExhausted(errors) {
  const messages = errors.map((err) => redactText(errorMessage(err)));
  const agg = new Error(`all fallback layers failed: ${messages.join(' | ')}`);
  agg.name = 'FallbackExhaustedError';
  agg.code = 'FALLBACK_EXHAUSTED';
  agg.errors = errors;
  return agg;
}

async function callOneModel(modelCall, callArgs, kimiConfig, timeoutMs) {
  return modelBreaker(kimiConfig).run(async () => {
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
      return await modelCall({ ...callArgs, kimiConfig, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (upstreamSignal) upstreamSignal.removeEventListener('abort', abortFromUpstream);
    }
  });
}

export async function callModelResilient(modelCall, callArgs, { kimiConfig, timeoutMs = 60000, onFallback } = {}) {
  const candidates = modelCandidates(kimiConfig);
  if (candidates.length <= 1) return callOneModel(modelCall, callArgs, candidates[0], timeoutMs);
  try {
    const routed = await runWithFallback(candidates, (candidate) => (
      callOneModel(modelCall, callArgs, candidate, timeoutMs)
    ), {
      shouldFallback: (err) => shouldFallbackModelError(err),
      onFallback: ({ failed, next, error }) => {
        if (typeof onFallback === 'function') {
          onFallback({
            failed: modelSummary(failed),
            next: modelSummary(next),
            error: redactText(errorMessage(error)),
          });
        }
      },
    });
    return routed.result;
  } catch (err) {
    if (err && Array.isArray(err.attempts)) {
      throw fallbackExhausted(err.attempts.map((attempt) => new Error(attempt.error)));
    }
    throw err;
  }
}

export function friendlyAgentError(err, context) {
  const trace = context && context.traceId ? `（追踪号 ${context.traceId}）` : '';
  if (err && err.code === 'CIRCUIT_OPEN') return `模型服务暂时不可用，已启用熔断保护，请稍后重试${trace}`;
  if (err && err.code === 'ETIMEDOUT') return `模型响应超时，请稍后重试${trace}`;
  const msg = redactText((err && err.message) || '发生未知错误');
  return `${msg}${trace ? ' ' + trace : ''}`;
}
