import { streamChat } from '../kimi/chat-stream.js';
import { streamAgentChat } from './agent-stream.js';
import { KIMI_API_NOT_CONFIGURED_MESSAGE } from '../kimi/api-runner.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { hasSessionModelAccess } from './session-model-config.js';
// @ts-check

/**
 * @typedef {{ tenantId: string, userId: string, traceId: string, [key: string]: any }} RequestContext
 * @typedef {(options: Record<string, any>) => Promise<Record<string, any>>} KimiRunner
 * @typedef {Error & { statusCode?: number, payload?: unknown }} RouteError
 */

/** @param {unknown} kimiConfig @returns {string} */
function modelProvider(kimiConfig) {
  const config = /** @type {Record<string, any>} */ (kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {});
  return String(config.provider || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

/** @param {unknown} value @returns {Array<{ provider: string, baseUrl: unknown, model: unknown, hasKey: boolean }>} */
function fallbackSummaries(value) { return Array.isArray(value) ? value.map((item) => ({ provider: modelProvider(item), baseUrl: item && item.baseUrl, model: item && item.model, hasKey: Boolean(item && item.apiKey) })) : []; }

/** @param {{ state: any, type: string, mode: string, trustedRoot: string, prompt: string, summary?: unknown, runner: KimiRunner, response: any, context: RequestContext }} options @returns {Promise<void>} */
async function runKimiAndRecord({ state, type, mode, trustedRoot, prompt, summary, runner, response, context }) {
  const runId = createRunId();
  const startedAt = new Date();
  /** @type {Record<string, any>} */
  const baseRecord = {
    id: runId,
    type,
    provider: modelProvider(state.kimiApiConfig),
    model: state.kimiApiConfig.model,
    baseUrl: state.kimiApiConfig.baseUrl,
    mode,
    trustedRoot,
    startedAt: startedAt.toISOString(),
    input: { prompt, summary: typeof summary === 'string' ? summary : '' },
    context,
  };
  const memoryContext = state.memoryStore.loadMemoryContext(trustedRoot, { maxBytes: 4096, context });
  if (memoryContext.enabled) {
    baseRecord.memory = { enabled: true, bytes: memoryContext.bytes, notes: memoryContext.notes };
  }

  try {
    const result = await runner({
      trustedRoot, prompt, summary, mode, memory: memoryContext.text,
      apiKey: state.kimiApiConfig.apiKey, baseUrl: state.kimiApiConfig.baseUrl,
      timeoutMs: state.kimiApiConfig.timeoutMs, maxTokens: state.kimiApiConfig.maxTokens, model: state.kimiApiConfig.model,
      provider: modelProvider(state.kimiApiConfig),
      userAgent: state.kimiApiConfig.userAgent, temperature: state.kimiApiConfig.temperature, fetchImpl: state.config.fetchImpl,
    });
    const finishedAt = new Date();
    const durationMs = result.durationMs ?? finishedAt.getTime() - startedAt.getTime();
    const runPath = writeRunRecord(state.runStoreRoot, /** @type {any} */ ({
      ...baseRecord,
      status: 'succeeded',
      finishedAt: finishedAt.toISOString(),
      durationMs,
      result: {
        ok: result.ok,
        text: result.text,
        provider: result.provider || baseRecord.provider,
        model: result.model || baseRecord.model,
        usage: result.usage || null,
      },
    }));
    state.indexRun({
      id: runId,
      type: baseRecord.type,
      status: 'succeeded',
      mode: baseRecord.mode,
      provider: baseRecord.provider,
      startedAt: baseRecord.startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs,
      input: baseRecord.input,
      runPath,
    }, context);
    sendJson(response, 200, {
      ...result,
      runId,
      runPath,
      memory: memoryContext.enabled
        ? { enabled: true, bytes: memoryContext.bytes, notes: memoryContext.notes }
        : { enabled: false },
    });
  } catch (err) {
    const error = /** @type {RouteError} */ (err);
    const finishedAt = new Date();
    const runPath = writeRunRecord(state.runStoreRoot, /** @type {any} */ ({
      ...baseRecord,
      status: 'failed',
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: { message: error.message },
    }));
    state.indexRun({
      id: runId,
      type: baseRecord.type,
      status: 'failed',
      mode: baseRecord.mode,
      provider: baseRecord.provider,
      startedAt: baseRecord.startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      input: baseRecord.input,
      runPath,
      error: { message: error.message },
    }, context);
    error.statusCode = /timed out/i.test(error.message) ? 504 : 502;
    error.payload = { runId, runPath };
    throw error;
  }
}

/** @param {any} response @param {any} state @returns {void} */
function sendKimiInfo(response, state) {
  sendJson(response, 200, {
    provider: modelProvider(state.kimiApiConfig),
    configured: state.kimiApiConfig.configured, planEnabled: state.kimiApiEnabled, chatEnabled: state.kimiApiEnabled,
    baseUrl: state.kimiApiConfig.baseUrl,
    model: state.kimiApiConfig.model,
    fallbacks: fallbackSummaries(state.kimiApiConfig.fallbacks),
    hasKey: Boolean(state.kimiApiConfig.apiKey),
  });
}

/** @param {{ request: any, response: any, pathname: string, requestContext: RequestContext, state: any }} options @returns {Promise<boolean>} */
export async function handleKimiRoutes({ request, response, pathname, requestContext, state }) {
  if (request.method === 'POST' && pathname === '/api/kimi/config') {
    await withJsonBody(request, response, async (body) => {
      const next = /** @type {Record<string, any>} */ (body && typeof body === 'object' ? body : {});
      if (next.clearKey === true) state.kimiApiConfig.apiKey = '';
      else if (typeof next.apiKey === 'string' && next.apiKey.trim()) state.kimiApiConfig.apiKey = next.apiKey.trim();
      if (typeof next.provider === 'string' && next.provider.trim()) state.kimiApiConfig.provider = modelProvider(next);
      if (Array.isArray(next.fallbacks)) state.kimiApiConfig.fallbacks = next.fallbacks;
      if (typeof next.baseUrl === 'string' && next.baseUrl.trim()) state.kimiApiConfig.baseUrl = next.baseUrl.trim().replace(/\/+$/, '');
      if (typeof next.model === 'string' && next.model.trim()) state.kimiApiConfig.model = next.model.trim();
      state.kimiApiConfig.configured = Boolean(state.kimiApiConfig.apiKey);
      state.recomputeKimiEnabled();
      try {
        state.persistKimiConfig();
      } catch (err) {
        const error = /** @type {{ message?: unknown }} */ (err || {});
        sendJson(response, 500, { error: 'Failed to persist Kimi config: ' + (error.message || 'unknown') });
        return;
      }
      sendKimiInfo(response, state);
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/kimi/info') {
    sendKimiInfo(response, state);
    return true;
  }

  if (request.method === 'POST' && (pathname === '/api/kimi/plan' || pathname === '/api/kimi/chat')) {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {Record<string, any>} */ (body && typeof body === 'object' ? body : {});
      if (!state.kimiApiEnabled) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        throw new Error('body.prompt is required');
      }
      const isPlan = pathname === '/api/kimi/plan';
      await runKimiAndRecord({
        state,
        type: isPlan ? 'kimi-plan' : 'kimi-chat',
        mode: isPlan && input.mode === 'code' ? 'code' : isPlan ? 'cowork' : 'chat',
        trustedRoot: state.safeTrustedRoot(input.trustedRoot),
        prompt: input.prompt,
        summary: input.summary,
        runner: isPlan ? state.kimiPlanRunner : state.kimiChatRunner,
        response,
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/agent/chat/stream') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {Record<string, unknown>} */ (body && typeof body === 'object' ? body : {});
      if (!state.kimiApiEnabled && !hasSessionModelAccess(input)) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim();
      const hasResumeRunId = typeof input.resumeRunId === 'string' && input.resumeRunId.trim();
      if (!hasPrompt && !hasResumeRunId) {
        sendJson(response, 400, { error: 'body.prompt or body.resumeRunId is required' });
        return;
      }
      if (state.draining) {
        sendJson(response, 503, { error: '服务正在停机，暂不接受新任务。', context: requestContext });
        return;
      }
      const releaseSlot = state.agentConcurrency.tryAcquire(requestContext.tenantId);
      if (!releaseSlot) {
        sendJson(response, 429, { error: '并发运行数已达上限，请稍后重试。', context: requestContext });
        return;
      }
      try {
        await streamAgentChat({
          response, request, requestContext, body: input, kimiConfig: state.kimiApiConfig,
          trustedRoot: state.safeTrustedRoot(input.trustedRoot),
          runStoreRoot: state.runStoreRoot, runsIndex: state.runsIndex, runEvents: state.runEvents,
          sandbox: state.sandboxEnabled ? state.sandbox : null, sandboxLimits: state.sandboxLimits,
          modelCall: state.config.agentModelCall, toolRegistry: state.toolRegistry, skillRegistry: state.skillRegistry,
          approvals: state.approvalRegistry, cancellation: state.cancellation, scheduler: state.activeScheduler,
        });
      } finally {
        releaseSlot();
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/kimi/chat/stream') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {Record<string, unknown>} */ (body && typeof body === 'object' ? body : {});
      if (!state.kimiApiEnabled) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        sendJson(response, 400, { error: 'body.prompt is required' });
        return;
      }
      await streamChat({
        response, requestContext, body: input, streamRunner: state.kimiChatStreamRunner,
        cancellation: state.cancellation, kimiConfig: state.kimiApiConfig,
        trustedRoot: state.safeTrustedRoot(input.trustedRoot),
        runStoreRoot: state.runStoreRoot, runsIndex: state.runsIndex,
      });
    });
    return true;
  }
  return false;
}
