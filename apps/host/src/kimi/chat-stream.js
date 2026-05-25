import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';

// SSE streaming chat with cancellation support: opens text/event-stream, emits
// `start`, a `token` frame per delta, then `done` (or `cancelled`/`error`), and
// records a kimi-chat run. The model call is an injectable streamRunner; an
// optional cancellation registry lets POST /api/runs/:id/cancel interrupt it.

function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function modelProvider(kimiConfig) {
  return String((kimiConfig && kimiConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

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

  let text = '';
  try {
    const result = await streamRunner({
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
      onToken: (delta) => { text += delta; sse(response, 'token', { delta }); },
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
      record('failed', { error: { message: err.message } });
      sse(response, 'error', { error: err.message });
    }
  } finally {
    if (cancellation) cancellation.done(runId);
    response.end();
  }
}
