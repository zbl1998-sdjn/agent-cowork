// SSE 流式聊天端点(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把一次非 agent 的简单对话以 text/event-stream 推给前端,逐 token 下发,
//       并把整次对话落盘成一条 agent-chat run 记录(成功/取消/失败三态)。
// 依赖:storage/run-store(落盘)、storage/runs-index(索引)、
//       ./system-prompt(env 块)、./agent-env(环境事实);模型调用由外部注入的 streamRunner 提供。
// 导出:streamChat —— 单一入口,被 routes 层装配。
import { createRunId, writeRunRecord } from '../storage/run-store.js';
import { summariseRunForIndex } from '../storage/runs-index.js';
import { omitUndefined } from '../util/object.js';
import { buildEnvBlock } from './system-prompt.js';
import { resolveAgentEnvFacts } from './agent-env.js';
import type { RequestContext } from '../http/middleware/common.js';

// SSE 简单聊天支持取消:打开 text/event-stream,按 delta 发送 token,最后发 done/cancelled/error。
// 模型调用由可注入 streamRunner 提供;可选 cancellation registry 让 /api/runs/:id/cancel 中断流。

type StreamResponse = {
  write(chunk?: string | Buffer): unknown;
  writeHead(statusCode: number, headers?: Record<string, string>): unknown;
  end(chunk?: string | Buffer): unknown;
};
type StreamBody = { prompt?: unknown; summary?: unknown; thinking?: unknown; model?: unknown };
type ModelConfig = {
  provider?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
  maxTokens?: unknown;
  userAgent?: unknown;
  temperature?: unknown;
  securityMode?: unknown;
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
  trustedRoot?: unknown;
  securityMode?: unknown;
  fetchImpl?: unknown;
  signal?: AbortSignal;
  onToken(delta: string): void;
  onReasoning(delta: string): void;
};
type StreamRunner = (input: StreamRunnerInput) => Promise<StreamResult> | StreamResult;
type RunsIndexLike = { upsert(summary: unknown, context?: RequestContext): unknown };
type CancellationLike = {
  register(runId: string, context: RequestContext): AbortController;
  done(runId: string, context: RequestContext): unknown;
};
type StreamChatOptions = {
  response: StreamResponse;
  requestContext: RequestContext;
  body: StreamBody;
  streamRunner: StreamRunner;
  modelConfig: ModelConfig;
  trustedRoot: string;
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  cancellation?: CancellationLike | null;
  fetchImpl?: unknown;
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
function modelProvider(modelConfig: ModelConfig): string {
  return String((modelConfig && modelConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

/** 入口:开启 SSE 流、逐 token 转发模型输出,并把整次对话记录为一条 run。 */
export async function streamChat({
  response,
  requestContext,
  body,
  streamRunner,
  modelConfig,
  trustedRoot,
  runStoreRoot,
  runsIndex,
  cancellation = null,
  fetchImpl,
}: StreamChatOptions): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const runId = createRunId();
  const startedAt = new Date();
  const controller = cancellation ? cancellation.register(runId, requestContext) : null;
  const signal = controller ? controller.signal : undefined;
  sse(response, 'start', { runId });

  /** 落盘一条 run 记录并更新索引;索引失败不应中断流。 @param {string} status @param {Record<string, unknown>} extra */
  const record = (status: string, extra: Record<string, unknown>): string => {
    const finishedAt = new Date();
    const base = {
      id: runId,
      type: 'agent-chat',
      provider: modelProvider(modelConfig),
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
      // 索引失败不能打断 SSE 流。
    }
    return String(runPath);
  };

  // 简单 chat 端点也注入今天日期/cwd/OS/model 的 env 块,避免「今天几号」落回模型训练截止时间。
  const envFacts = resolveAgentEnvFacts({ trustedRoot, modelConfig });
  const systemMessage = buildEnvBlock(envFacts).join('\n');

  let text = '';
  try {
    const result = await streamRunner(omitUndefined({
      systemMessage,
      prompt: body.prompt,
      summary: body.summary,
      thinking: body.thinking,
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      model: body.model || modelConfig.model,
      provider: modelProvider(modelConfig),
      timeoutMs: modelConfig.timeoutMs,
      maxTokens: modelConfig.maxTokens,
      userAgent: modelConfig.userAgent,
      temperature: modelConfig.temperature,
      trustedRoot,
      securityMode: modelConfig.securityMode,
      fetchImpl,
      signal,
      onToken: (delta: string) => { text += String(delta); sse(response, 'token', { delta }); },
      onReasoning: (delta: string) => sse(response, 'reasoning', { delta }),
    }));
    text = (result && result.text) || text;
    const model = (result && result.model) || modelConfig.model;
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
    if (cancellation) cancellation.done(runId, requestContext);
    response.end();
  }
}
