// SSE 流式聊天端点(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把一次非 agent 的简单对话以 text/event-stream 推给前端,逐 token 下发,
//       并把整次对话落盘成一条 kimi-chat run 记录(成功/取消/失败三态)。
// 依赖:runtime/run-store(落盘)、runtime/runs-index(索引)、
//       ./system-prompt(env 块)、./agent-env(环境事实);模型调用由外部注入的 streamRunner 提供。
// 导出:streamChat —— 单一入口,被 routes 层装配。
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { omitUndefined } from '../util/object.js';
import { buildEnvBlock } from './system-prompt.js';
import { resolveAgentEnvFacts } from './agent-env.js';
import type { RequestContext } from '../http/middleware/common.js';

// SSE streaming chat with cancellation support: opens text/event-stream, emits
// `start`, a `token` frame per delta, then `done` (or `cancelled`/`error`), and
// records a kimi-chat run. The model call is an injectable streamRunner; an
// optional cancellation registry lets POST /api/runs/:id/cancel interrupt it.

type StreamResponse = {
  write(chunk?: string | Buffer): unknown;
  writeHead(statusCode: number, headers?: Record<string, string>): unknown;
  end(chunk?: string | Buffer): unknown;
};
type StreamBody = { prompt?: unknown; summary?: unknown; thinking?: unknown; model?: unknown };
type KimiConfig = {
  provider?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
  maxTokens?: unknown;
  userAgent?: unknown;
  temperature?: unknown;
};
type StreamResult = { text?: string; model?: unknown; usage?: unknown };
type StreamRunnerInput = {
  systemMessage?: string;
  prompt?: unknown;
  summary?: unknown;
  thinking?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  provider: string;
  timeoutMs?: unknown;
  maxTokens?: unknown;
  userAgent?: unknown;
  temperature?: unknown;
  signal?: AbortSignal;
  onToken(delta: string): void;
  onReasoning(delta: string): void;
};
type StreamRunner = (input: StreamRunnerInput) => Promise<StreamResult> | StreamResult;
type RunsIndexLike = { upsert(summary: unknown, context?: RequestContext): unknown };
type CancellationLike = { register(runId: string): AbortController; done(runId: string): unknown };
type StreamChatOptions = {
  response: StreamResponse;
  requestContext: RequestContext;
  body: StreamBody;
  streamRunner: StreamRunner;
  kimiConfig: KimiConfig;
  trustedRoot: string;
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  cancellation?: CancellationLike | null;
};

/** 把任意抛出物归一成可展示的错误字符串。 */
function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message || 'stream failed');
  }
  return String(err || 'stream failed');
}

/** 按 SSE 帧格式写出一个 event + JSON data。 */
function sse(response: StreamResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 取出归一化后的 provider 名(缺省 kimi-api)。 */
function modelProvider(kimiConfig: KimiConfig): string {
  return String((kimiConfig && kimiConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

/** 入口:开启 SSE 流、逐 token 转发模型输出,并把整次对话记录为一条 run。 */
export async function streamChat({
  response,
  requestContext,
  body,
  streamRunner,
  kimiConfig,
  trustedRoot,
  runStoreRoot,
  runsIndex,
  cancellation = null,
}: StreamChatOptions): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const runId = createRunId();
  const startedAt = new Date();
  const controller = cancellation ? cancellation.register(runId) : null;
  const signal = controller ? controller.signal : undefined;
  sse(response, 'start', { runId });

  /** 落盘一条 run 记录并更新索引;索引失败不应中断流。 @param {string} status @param {Record<string, unknown>} extra */
  const record = (status: string, extra: Record<string, unknown>): string => {
    const finishedAt = new Date();
    const base = {
      id: runId,
      type: 'kimi-chat',
      provider: modelProvider(kimiConfig),
      mode: 'chat',
      trustedRoot,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status,
      context: requestContext,
      input: { prompt: String(body.prompt || '') },
      ...extra,
    };
    const runPath = writeRunRecord(runStoreRoot, base);
    try {
      runsIndex.upsert(summariseRunForIndex({ ...base, runPath }, requestContext), requestContext);
    } catch {
      // index failure must not break the stream
    }
    return String(runPath);
  };

  // Stamp a system message with today's real-world date / cwd / OS / model so
  // chat mode (the simple non-agent endpoint) also gets the env-block grounding
  // that agent mode picks up via buildSystemPrompt. Without this, "今天几号"
  // would fall back to the model's training cutoff (Kimi K2: 2024-end).
  const envFacts = resolveAgentEnvFacts({ trustedRoot, kimiConfig });
  const systemMessage = buildEnvBlock(envFacts).join('\n');

  let text = '';
  try {
    const result = await streamRunner(omitUndefined({
      systemMessage,
      prompt: body.prompt,
      summary: body.summary,
      thinking: body.thinking,
      apiKey: kimiConfig.apiKey,
      baseUrl: kimiConfig.baseUrl,
      model: body.model || kimiConfig.model,
      provider: modelProvider(kimiConfig),
      timeoutMs: kimiConfig.timeoutMs,
      maxTokens: kimiConfig.maxTokens,
      userAgent: kimiConfig.userAgent,
      temperature: kimiConfig.temperature,
      signal,
      onToken: (delta: string) => { text += String(delta); sse(response, 'token', { delta }); },
      onReasoning: (delta: string) => sse(response, 'reasoning', { delta }),
    }));
    text = (result && result.text) || text;
    const model = (result && result.model) || kimiConfig.model;
    const usage = (result && result.usage) || null;

    if (signal && signal.aborted) {
      const runPath = record('cancelled', { result: { ok: false, cancelled: true, text, model } });
      sse(response, 'cancelled', { runId, runPath, text, model });
    } else {
      const runPath = record('succeeded', { model, result: { ok: true, text, model, usage } });
      sse(response, 'done', { runId, runPath, text, model, usage });
    }
  } catch (err) {
    if (signal && signal.aborted) {
      const runPath = record('cancelled', { result: { ok: false, cancelled: true, text } });
      sse(response, 'cancelled', { runId, runPath, text });
    } else {
      record('failed', { error: { message: errorMessage(err) } });
      sse(response, 'error', { error: errorMessage(err) });
    }
  } finally {
    if (cancellation) cancellation.done(runId);
    response.end();
  }
}
