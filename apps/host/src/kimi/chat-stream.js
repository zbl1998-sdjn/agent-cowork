// @ts-check
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { buildEnvBlock } from './system-prompt.js';
import { resolveAgentEnvFacts } from './agent-env.js';

// SSE streaming chat with cancellation support: opens text/event-stream, emits
// `start`, a `token` frame per delta, then `done` (or `cancelled`/`error`), and
// records a kimi-chat run. The model call is an injectable streamRunner; an
// optional cancellation registry lets POST /api/runs/:id/cancel interrupt it.

/**
 * @typedef {import('../http/request-utils.js').HttpResponseLike & { write(chunk?: string | Buffer): unknown, writeHead(statusCode: number, headers?: Record<string, string>): unknown }} StreamResponse
 * @typedef {import('../http/middleware/common.js').RequestContext} RequestContext
 * @typedef {{ prompt?: unknown, summary?: unknown, thinking?: unknown, model?: unknown }} StreamBody
 * @typedef {{ provider?: unknown, apiKey?: unknown, baseUrl?: unknown, model?: unknown, timeoutMs?: unknown, maxTokens?: unknown, userAgent?: unknown, temperature?: unknown }} KimiConfig
 * @typedef {{ text?: string, model?: unknown, usage?: unknown }} StreamResult
 * @typedef {{ systemMessage?: string, prompt?: unknown, summary?: unknown, thinking?: unknown, apiKey?: unknown, baseUrl?: unknown, model?: unknown, provider: string, timeoutMs?: unknown, maxTokens?: unknown, userAgent?: unknown, temperature?: unknown, signal?: AbortSignal, onToken(delta: string): void, onReasoning(delta: string): void }} StreamRunnerInput
 * @typedef {(input: StreamRunnerInput) => Promise<StreamResult> | StreamResult} StreamRunner
 * @typedef {{ upsert(summary: unknown, context?: RequestContext): unknown }} RunsIndexLike
 * @typedef {{ register(runId: string): AbortController, done(runId: string): unknown }} CancellationLike
 * @typedef {{ response: StreamResponse, requestContext: RequestContext, body: StreamBody, streamRunner: StreamRunner, kimiConfig: KimiConfig, trustedRoot: string, runStoreRoot: string, runsIndex: RunsIndexLike, cancellation?: CancellationLike | null }} StreamChatOptions
 * @typedef {Error & { name?: string }} RouteError
 */

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  return /** @type {Partial<RouteError>} */ (err)?.message || String(err || 'stream failed');
}

/** @param {StreamResponse} response @param {string} event @param {unknown} data */
function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** @param {KimiConfig} kimiConfig */
function modelProvider(kimiConfig) {
  return String((kimiConfig && kimiConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

/** @param {StreamChatOptions} options */
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
}) {
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

  /** @param {string} status @param {Record<string, unknown>} extra */
  const record = (status, extra) => {
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
    return runPath;
  };

  // Stamp a system message with today's real-world date / cwd / OS / model so
  // chat mode (the simple non-agent endpoint) also gets the env-block grounding
  // that agent mode picks up via buildSystemPrompt. Without this, "今天几号"
  // would fall back to the model's training cutoff (Kimi K2: 2024-end).
  const envFacts = resolveAgentEnvFacts({ trustedRoot, kimiConfig });
  const systemMessage = buildEnvBlock(envFacts).join('\n');

  let text = '';
  try {
    const result = await streamRunner({
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
      onToken: (delta) => { text += String(delta); sse(response, 'token', { delta }); },
      onReasoning: (delta) => sse(response, 'reasoning', { delta }),
    });
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
