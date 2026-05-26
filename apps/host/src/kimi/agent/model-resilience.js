// @ts-check
import { redactText } from '../../security/redaction.js';
import { modelBreaker, modelBreakerStats, modelProvider } from '../../runtime/model-breakers.js';
import { runWithFallback } from '../provider/router.js';

export { modelBreakerStats };

/**
 * @typedef {Record<string, unknown> & { apiKey?: unknown, fallbacks?: unknown, provider?: unknown, baseUrl?: unknown, model?: unknown }} ModelConfig
 * @typedef {Record<string, unknown> & { signal?: AbortSignal }} ModelCallArgs
 * @typedef {(args: ModelCallArgs & { kimiConfig: ModelConfig, signal: AbortSignal }) => unknown | Promise<unknown>} ModelCall
 * @typedef {Error & { code?: string, errors?: unknown[] }} ModelError
 * @typedef {{ attempts?: Array<{ error: unknown }> }} FallbackError
 * @typedef {{ kimiConfig?: unknown, timeoutMs?: number, onFallback?: (event: { failed: unknown, next: unknown, error: string }) => void }} ResilienceOptions
 */

/** @param {unknown} value @returns {ModelConfig} */
function objectConfig(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {ModelConfig} */ (value) : {};
}

/** @param {unknown} primary @param {unknown} fallback @returns {ModelConfig} */
function fallbackConfig(primary, fallback) {
  const source = objectConfig(fallback);
  const {
    apiKey: _apiKey, fallbacks: _fallbacks, provider: _provider, baseUrl: _baseUrl, model: _model, ...shared
  } = objectConfig(primary);
  const out = { ...shared, ...source };
  if (!Object.prototype.hasOwnProperty.call(source, 'apiKey')) delete out.apiKey;
  delete out.fallbacks;
  return out;
}

/** @param {unknown} kimiConfig @returns {ModelConfig[]} */
function modelCandidates(kimiConfig) {
  const primary = objectConfig(kimiConfig);
  const fallbacks = Array.isArray(primary.fallbacks) ? primary.fallbacks : [];
  return [fallbackConfig(primary, primary), ...fallbacks.map((item) => fallbackConfig(primary, item))];
}

/** @param {unknown} kimiConfig */
function modelSummary(kimiConfig) {
  const config = objectConfig(kimiConfig);
  return {
    provider: modelProvider(config),
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.apiKey),
  };
}

/** @param {unknown} err */
function errorMessage(err) {
  return /** @type {Partial<ModelError>} */ (err)?.message || String(err || 'model call failed');
}

/** @param {unknown} err */
function shouldFallbackModelError(err) {
  const error = /** @type {Partial<ModelError>} */ (err);
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

/** @param {unknown[]} errors @returns {ModelError} */
function fallbackExhausted(errors) {
  const messages = errors.map((err) => redactText(errorMessage(err)));
  const agg = /** @type {ModelError} */ (new Error(`all fallback layers failed: ${messages.join(' | ')}`));
  agg.name = 'FallbackExhaustedError';
  agg.code = 'FALLBACK_EXHAUSTED';
  agg.errors = errors;
  return agg;
}

/** @param {ModelCall} modelCall @param {ModelCallArgs} callArgs @param {ModelConfig} kimiConfig @param {number} timeoutMs */
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

/** @param {ModelCall} modelCall @param {ModelCallArgs} callArgs @param {ResilienceOptions} [options] */
export async function callModelResilient(modelCall, callArgs, { kimiConfig, timeoutMs = 60000, onFallback } = {}) {
  const candidates = modelCandidates(kimiConfig);
  if (candidates.length <= 1) return callOneModel(modelCall, callArgs, candidates[0], timeoutMs);
  try {
    const routed = await runWithFallback(candidates, (candidate) => (
      callOneModel(modelCall, callArgs, /** @type {ModelConfig} */ (candidate), timeoutMs)
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
    const error = /** @type {FallbackError} */ (err && typeof err === 'object' ? err : {});
    if (Array.isArray(error.attempts)) {
      throw fallbackExhausted(error.attempts.map((attempt) => new Error(String(attempt.error))));
    }
    throw err;
  }
}

/** @param {unknown} err @param {{ traceId?: unknown }} context */
export function friendlyAgentError(err, context) {
  const trace = context && context.traceId ? `（追踪号 ${context.traceId}）` : '';
  const error = /** @type {Partial<ModelError>} */ (err);
  if (error?.code === 'CIRCUIT_OPEN') return `模型服务暂时不可用，已启用熔断保护，请稍后重试${trace}`;
  if (error?.code === 'ETIMEDOUT') return `模型响应超时，请稍后重试${trace}`;
  const msg = redactText(error?.message || '发生未知错误');
  return `${msg}${trace ? ' ' + trace : ''}`;
}
