// Kimi 路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/kimi/* —— Kimi 配置读写、CLI 探测、以及把对话请求接到流式聊天(SSE)。
// 依赖:L1 kimi(chat-stream/config-store/cli-* 等,经 state 注入)。导出:handleKimiRoutes。
import { streamChat } from '../kimi/chat-stream.js';
import { streamAgentChat } from './agent-stream.js';
import { KIMI_API_NOT_CONFIGURED_MESSAGE } from '../kimi/api-runner.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { hasSessionModelAccess } from './session-model-config.js';
import {
  kimiAgentStreamBodySchema,
  kimiChatStreamBodySchema,
  kimiConfigBodySchema,
  kimiPlanChatBodySchema,
  normalizeKimiFallbacks,
  parseKimiBody,
} from './kimi-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { KimiApiConfig } from '../kimi/api-runner-config.js';
import type { HostState } from '../runtime/host-state-types.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number; payload?: Record<string, unknown> };
type MemoryContext = { enabled?: boolean; bytes?: unknown; notes?: unknown; text?: string };
type MemoryStoreLike = {
  loadMemoryContext(root: string, options: { maxBytes: number; context: RequestContext }): MemoryContext;
};
type KimiRunnerResult = {
  ok?: unknown;
  text?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
  durationMs?: number;
};
type KimiRunner = (options: Record<string, unknown>) => Promise<KimiRunnerResult> | KimiRunnerResult;
type AgentConcurrencyLike = { tryAcquire(tenantId?: string): (() => void) | null };
type StreamChatRunner = Parameters<typeof streamChat>[0]['streamRunner'];
type KimiRouteState = HostState & {
  memoryStore: MemoryStoreLike;
  kimiApiConfig: KimiApiConfig;
  kimiApiEnabled?: boolean;
  kimiPlanRunner: KimiRunner;
  kimiChatRunner: KimiRunner;
  kimiChatStreamRunner: StreamChatRunner;
  recomputeKimiEnabled: () => unknown;
  persistKimiConfig: () => void;
  indexRun: (record: Record<string, unknown>, context: RequestContext) => void;
  agentConcurrency: AgentConcurrencyLike;
};
type KimiRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  state: HostState;
};
type RunKimiAndRecordOptions = {
  state: KimiRouteState;
  type: string;
  mode: string;
  trustedRoot: string;
  prompt: string;
  summary?: unknown;
  runner: KimiRunner;
  response: HttpResponseLike;
  context: RequestContext;
};

function asRouteError(err: unknown): RouteError {
  if (err instanceof Error) return err as RouteError;
  return new Error(String(err || 'request failed')) as RouteError;
}

function modelProvider(kimiConfig: unknown): string {
  const config = kimiConfig && typeof kimiConfig === 'object'
    ? kimiConfig as { provider?: unknown }
    : {};
  return String(config.provider || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

function fallbackSummaries(value: unknown): Array<{ provider: string; baseUrl: unknown; model: unknown; hasKey: boolean }> {
  return Array.isArray(value)
    ? value.map((item) => {
      const fallback = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        provider: modelProvider(fallback),
        baseUrl: fallback.baseUrl,
        model: fallback.model,
        hasKey: Boolean(fallback.apiKey),
      };
    })
    : [];
}

async function runKimiAndRecord({
  state,
  type,
  mode,
  trustedRoot,
  prompt,
  summary,
  runner,
  response,
  context,
}: RunKimiAndRecordOptions): Promise<void> {
  const runId = createRunId();
  const startedAt = new Date();
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
    Object.assign(baseRecord, {
      memory: { enabled: true, bytes: memoryContext.bytes, notes: memoryContext.notes },
    });
  }

  try {
    const result = await runner({
      trustedRoot,
      prompt,
      summary,
      mode,
      memory: memoryContext.text || '',
      apiKey: state.kimiApiConfig.apiKey,
      baseUrl: state.kimiApiConfig.baseUrl,
      timeoutMs: state.kimiApiConfig.timeoutMs,
      maxTokens: state.kimiApiConfig.maxTokens,
      model: state.kimiApiConfig.model,
      provider: modelProvider(state.kimiApiConfig),
      userAgent: state.kimiApiConfig.userAgent,
      temperature: state.kimiApiConfig.temperature,
      fetchImpl: state.config.fetchImpl,
    });
    const finishedAt = new Date();
    const durationMs = result.durationMs ?? finishedAt.getTime() - startedAt.getTime();
    const runPath = writeRunRecord(state.runStoreRoot, {
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
    });
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
    const error = asRouteError(err);
    const finishedAt = new Date();
    const runPath = writeRunRecord(state.runStoreRoot, {
      ...baseRecord,
      status: 'failed',
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error: { message: error.message },
    });
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

function sendKimiInfo(response: HttpResponseLike, state: KimiRouteState): void {
  sendJson(response, 200, {
    provider: modelProvider(state.kimiApiConfig),
    configured: state.kimiApiConfig.configured,
    planEnabled: state.kimiApiEnabled,
    chatEnabled: state.kimiApiEnabled,
    baseUrl: state.kimiApiConfig.baseUrl,
    model: state.kimiApiConfig.model,
    fallbacks: fallbackSummaries(state.kimiApiConfig.fallbacks),
    hasKey: Boolean(state.kimiApiConfig.apiKey),
  });
}

export async function handleKimiRoutes({
  request,
  response,
  pathname,
  requestContext,
  state,
}: KimiRouteOptions): Promise<boolean> {
  const routeState = state as KimiRouteState;

  if (request.method === 'POST' && pathname === '/api/kimi/config') {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiConfigBodySchema, body, 'invalid kimi config request');
      if (!input) return;
      if (input.clearKey === true) routeState.kimiApiConfig.apiKey = '';
      else if (input.apiKey?.trim()) routeState.kimiApiConfig.apiKey = input.apiKey.trim();
      if (input.provider?.trim()) routeState.kimiApiConfig.provider = modelProvider(input);
      if (input.fallbacks) routeState.kimiApiConfig.fallbacks = normalizeKimiFallbacks(input.fallbacks);
      if (input.baseUrl?.trim()) routeState.kimiApiConfig.baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
      if (input.model?.trim()) routeState.kimiApiConfig.model = input.model.trim();
      routeState.kimiApiConfig.configured = Boolean(routeState.kimiApiConfig.apiKey);
      routeState.recomputeKimiEnabled();
      try {
        routeState.persistKimiConfig();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err || 'unknown'));
        sendJson(response, 500, { error: `Failed to persist Kimi config: ${error.message || 'unknown'}` });
        return;
      }
      sendKimiInfo(response, routeState);
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/kimi/info') {
    sendKimiInfo(response, routeState);
    return true;
  }

  if (request.method === 'POST' && (pathname === '/api/kimi/plan' || pathname === '/api/kimi/chat')) {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiPlanChatBodySchema, body, 'invalid kimi request');
      if (!input) return;
      if (!routeState.kimiApiEnabled) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      const isPlan = pathname === '/api/kimi/plan';
      await runKimiAndRecord({
        state: routeState,
        type: isPlan ? 'kimi-plan' : 'kimi-chat',
        mode: isPlan && input.mode === 'code' ? 'code' : isPlan ? 'cowork' : 'chat',
        trustedRoot: routeState.safeTrustedRoot(input.trustedRoot),
        prompt: input.prompt,
        summary: input.summary,
        runner: isPlan ? routeState.kimiPlanRunner : routeState.kimiChatRunner,
        response,
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/agent/chat/stream') {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiAgentStreamBodySchema, body, 'invalid agent stream request');
      if (!input) return;
      if (!routeState.kimiApiEnabled && !hasSessionModelAccess(input)) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim();
      const hasResumeRunId = typeof input.resumeRunId === 'string' && input.resumeRunId.trim();
      if (!hasPrompt && !hasResumeRunId) {
        sendJson(response, 400, { error: 'body.prompt or body.resumeRunId is required' });
        return;
      }
      if (routeState.draining) {
        sendJson(response, 503, { error: '服务正在停机，暂不接受新任务。', context: requestContext });
        return;
      }
      const releaseSlot = routeState.agentConcurrency.tryAcquire(requestContext.tenantId);
      if (!releaseSlot) {
        sendJson(response, 429, { error: '并发运行数已达上限，请稍后重试。', context: requestContext });
        return;
      }
      try {
        // HostState 仍保留若干运行时注入槽为 unknown; 这里把松散 state 适配到流式 Agent 模块的窄契约。
        await streamAgentChat({
          response,
          request,
          requestContext,
          body: input,
          kimiConfig: routeState.kimiApiConfig,
          trustedRoot: routeState.safeTrustedRoot(input.trustedRoot),
          runStoreRoot: routeState.runStoreRoot,
          runsIndex: routeState.runsIndex,
          runEvents: routeState.runEvents,
          sandbox: routeState.sandboxEnabled ? routeState.sandbox : null,
          sandboxLimits: routeState.sandboxLimits,
          modelCall: routeState.config.agentModelCall,
          toolRegistry: routeState.toolRegistry,
          skillRegistry: routeState.skillRegistry,
          approvals: routeState.approvalRegistry,
          cancellation: routeState.cancellation,
          scheduler: routeState.activeScheduler,
        } as unknown as Parameters<typeof streamAgentChat>[0]);
      } finally {
        releaseSlot();
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/kimi/chat/stream') {
    await withJsonBody(request, response, async (body) => {
      const input = parseKimiBody(response, kimiChatStreamBodySchema, body, 'invalid kimi stream request');
      if (!input) return;
      if (!routeState.kimiApiEnabled) {
        sendJson(response, 503, { error: KIMI_API_NOT_CONFIGURED_MESSAGE });
        return;
      }
      await streamChat({
        response,
        requestContext,
        body: input,
        streamRunner: routeState.kimiChatStreamRunner,
        cancellation: routeState.cancellation,
        kimiConfig: routeState.kimiApiConfig,
        trustedRoot: routeState.safeTrustedRoot(input.trustedRoot),
        runStoreRoot: routeState.runStoreRoot,
        runsIndex: routeState.runsIndex,
      } as unknown as Parameters<typeof streamChat>[0]);
    });
    return true;
  }
  return false;
}
