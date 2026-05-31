// Kimi 路由支撑(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:封装 Kimi 配置响应、provider 归一化、运行记录落盘与索引,保持主路由只做分支编排。
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { KimiApiConfig } from '../kimi/api-runner-config.js';
import type { HostState } from '../runtime/host-state-types.js';
import type { streamChat } from '../kimi/chat-stream.js';

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
export type KimiRunner = (options: Record<string, unknown>) => Promise<KimiRunnerResult> | KimiRunnerResult;
type AgentConcurrencyLike = { tryAcquire(tenantId?: string): (() => void) | null };
type StreamChatRunner = Parameters<typeof streamChat>[0]['streamRunner'];

export type KimiRouteState = HostState & {
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

type RouteError = Error & { statusCode?: number; payload?: Record<string, unknown> };

function asRouteError(err: unknown): RouteError {
  if (err instanceof Error) return err as RouteError;
  return new Error(String(err || 'request failed')) as RouteError;
}

export function modelProvider(kimiConfig: unknown): string {
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

export async function runKimiAndRecord({
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
    Object.assign(baseRecord, { memory: { enabled: true, bytes: memoryContext.bytes, notes: memoryContext.notes } });
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

export function sendKimiInfo(response: HttpResponseLike, state: KimiRouteState): void {
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
