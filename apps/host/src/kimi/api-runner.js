// @ts-check
// Kimi API 直答运行器:OpenAI 兼容的 chat/completions 调用(同步与流式)(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:发起 OpenAI 兼容的 /chat/completions 请求,处理超时中止、提取回复文本;
//       提供计划/聊天两种非流式入口与一个 SSE 流式聊天入口。
// 依赖:同层 ./api-runner-config.js(常量/provider 归一)、./api-runner-prompts.js
//       (提示词拼装);运行期用全局 fetch。
// 导出:runKimiApiPlan、runKimiApiChat、runKimiApiChatStream,以及再导出配置/提示构造器。
import { cleanProvider, cleanText, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, KIMI_API_NOT_CONFIGURED_MESSAGE } from './api-runner-config.js';
import { extractMessageText } from './api-runner-payload.js';
import { buildKimiApiChatPrompt, buildKimiApiPlanPrompt } from './api-runner-prompts.js';

export { KIMI_API_NOT_CONFIGURED_MESSAGE, resolveKimiApiConfig } from './api-runner-config.js';
export { buildKimiApiChatPrompt, buildKimiApiPlanPrompt } from './api-runner-prompts.js';

/**
 * @typedef {{ usage?: unknown, choices?: Array<{ message?: { content?: unknown }, delta?: { content?: unknown, reasoning_content?: unknown } }> }} KimiPayload
 * @typedef {{ ok: boolean, provider: string, model: string, mode: string, text: string, durationMs: number, usage?: unknown }} KimiTextResult
 * @typedef {{ prompt?: unknown, summary?: unknown, mode?: unknown, memory?: unknown, systemMessage?: string, apiKey?: unknown, baseUrl?: unknown, model?: unknown, provider?: unknown, timeoutMs?: unknown, maxTokens?: unknown, fetchImpl?: typeof fetch, userAgent?: unknown, temperature?: unknown, promptBuilder?: (options: { prompt?: unknown, summary?: unknown, mode?: unknown, memory?: unknown }) => string, resultMode?: string }} KimiTextOptions
 * @typedef {KimiTextOptions & { onToken?: (delta: string) => void, onReasoning?: (delta: string) => void, signal?: AbortSignal }} KimiStreamOptions
 */

/** 非流式直答核心:校验 key/fetch、超时中止、发请求并返回规范化文本结果。 @param {KimiTextOptions} [options] @returns {Promise<KimiTextResult>} */
async function runKimiApiText({
  prompt,
  summary,
  mode,
  memory = '',
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  provider = 'kimi-api',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = globalThis.fetch,
  userAgent,
  temperature,
  promptBuilder,
  resultMode,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(KIMI_API_NOT_CONFIGURED_MESSAGE);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Kimi API calls');
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  if (typeof promptBuilder !== 'function') {
    throw new Error('promptBuilder is required');
  }
  const apiPrompt = promptBuilder({ prompt, summary, mode, memory });

  try {
    const headers = /** @type {Record<string, string>} */ ({
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    });
    if (userAgent) headers['user-agent'] = String(userAgent);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: String(model || DEFAULT_MODEL),
        messages: [
          {
            role: 'user',
            content: apiPrompt,
          },
        ],
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Kimi API request failed with status ${response.status}`);
    }

    const payload = /** @type {KimiPayload} */ (await response.json());
    const text = extractMessageText(payload);
    if (!text) {
      throw new Error('Kimi API returned empty output');
    }

    return {
      ok: true,
      provider: cleanProvider(provider),
      model: String(model || DEFAULT_MODEL),
      mode: resultMode || (mode === 'code' ? 'code' : 'cowork'),
      text,
      durationMs: Date.now() - startedAt,
      usage: payload.usage || null,
    };
  } catch (error) {
    if (error && typeof error === 'object' && /** @type {{ name?: unknown }} */ (error).name === 'AbortError') {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 计划模式直答:用 plan 提示构造器走非流式调用。 @param {KimiTextOptions} [options] */
export function runKimiApiPlan(options = {}) {
  return runKimiApiText({
    ...options,
    promptBuilder: buildKimiApiPlanPrompt,
    resultMode: options.mode === 'code' ? 'code' : 'cowork',
  });
}

/** 聊天模式直答:用 chat 提示构造器走非流式调用。 @param {KimiTextOptions} [options] */
export function runKimiApiChat(options = {}) {
  return runKimiApiText({
    ...options,
    promptBuilder: buildKimiApiChatPrompt,
    resultMode: 'chat',
  });
}

// Streaming chat: same OpenAI-compatible request with stream:true, parsing the
// upstream SSE and invoking onToken(delta) per content chunk. Returns the full
// accumulated text. Used by POST /api/kimi/chat/stream.
/** 流式聊天:stream:true 调用并逐块解析 SSE,通过 onToken/onReasoning 回调增量推送,返回累计文本。 @param {KimiStreamOptions} [options] @returns {Promise<KimiTextResult>} */
export async function runKimiApiChatStream({
  prompt,
  summary = '',
  memory = '',
  systemMessage = '',
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  provider = 'kimi-api',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = globalThis.fetch,
  onToken,
  onReasoning,
  signal,
  userAgent,
  temperature,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error(KIMI_API_NOT_CONFIGURED_MESSAGE);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Kimi API calls');
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const apiPrompt = buildKimiApiChatPrompt({ prompt, summary, memory });
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let text = '';
  try {
    const headers = /** @type {Record<string, string>} */ ({
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });
    if (userAgent) headers['user-agent'] = String(userAgent);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: String(model || DEFAULT_MODEL),
        // Prepend the system message (env block etc.) when present so the
        // model gets today's-date grounding before the user content.
        messages: systemMessage
          ? [{ role: 'system', content: String(systemMessage) }, { role: 'user', content: apiPrompt }]
          : [{ role: 'user', content: apiPrompt }],
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Kimi API request failed with status ${response.status}`);
    }
    const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
    if (!reader) {
      throw new Error('streaming not supported by this fetch implementation');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { buffer = ''; break; }
        try {
          const json = /** @type {KimiPayload} */ (JSON.parse(data));
          const choiceDelta = json.choices?.[0]?.delta || {};
          const reasoning = typeof choiceDelta.reasoning_content === 'string' ? choiceDelta.reasoning_content : '';
          if (reasoning && typeof onReasoning === 'function') onReasoning(reasoning);
          const delta = typeof choiceDelta.content === 'string' ? choiceDelta.content : '';
          if (delta) {
            text += delta;
            if (typeof onToken === 'function') onToken(delta);
          }
        } catch {
          // ignore partial / non-JSON keepalive lines
        }
      }
    }
    return { ok: true, provider: cleanProvider(provider), model: String(model || DEFAULT_MODEL), mode: 'chat', text, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error && typeof error === 'object' && /** @type {{ name?: unknown }} */ (error).name === 'AbortError') {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
