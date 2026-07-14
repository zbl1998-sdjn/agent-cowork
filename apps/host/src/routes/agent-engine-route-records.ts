// Kimi 运行记录落盘(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:执行一次模型运行并把成功/失败证据落盘 + 索引,把结果作为 JSON 响应返回。
//       自 agent-engine-route-support.ts 拆出以控制单文件行数,行为不变。
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { AtRestKeyError } from '../security/at-rest.js';
import { isEgressAuditFailure } from '../security/egress-gateway.js';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike, RequestContext } from '../http/request-utils.js';
import { modelProvider } from './agent-engine-route-support.js';
import type { AgentEngineRouteState, ModelRunner } from './agent-engine-route-support.js';

type RouteError = Error & { statusCode?: number; payload?: Record<string, unknown> };

type RunKimiAndRecordOptions = {
  state: AgentEngineRouteState;
  type: string;
  mode: string;
  trustedRoot: string;
  prompt: string;
  summary?: unknown;
  runner: ModelRunner;
  response: HttpResponseLike;
  context: RequestContext;
};

function asRouteError(err: unknown): RouteError {
  if (err instanceof Error) return err as RouteError;
  return new Error(String(err || 'request failed')) as RouteError;
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
    provider: modelProvider(state.agentModelConfig),
    model: state.agentModelConfig.model,
    baseUrl: state.agentModelConfig.baseUrl,
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
      apiKey: state.agentModelConfig.apiKey,
      baseUrl: state.agentModelConfig.baseUrl,
      timeoutMs: state.agentModelConfig.timeoutMs,
      maxTokens: state.agentModelConfig.maxTokens,
      model: state.agentModelConfig.model,
      provider: modelProvider(state.agentModelConfig),
      userAgent: state.agentModelConfig.userAgent,
      temperature: state.agentModelConfig.temperature,
      securityMode: state.agentModelConfig.securityMode,
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
    if (err instanceof AtRestKeyError) throw err;
    if (isEgressAuditFailure(err)) throw err;
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
