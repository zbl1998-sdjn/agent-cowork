import {
  cleanProvider,
  cleanText,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  KIMI_API_NOT_CONFIGURED_MESSAGE,
} from './api-runner-config.js';
import { buildKimiApiChatPrompt, buildKimiApiPlanPrompt } from './api-runner-prompts.js';

export { KIMI_API_NOT_CONFIGURED_MESSAGE, resolveKimiApiConfig } from './api-runner-config.js';
export { buildKimiApiChatPrompt, buildKimiApiPlanPrompt } from './api-runner-prompts.js';

function extractMessageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return cleanText(content);
  }
  if (Array.isArray(content)) {
    return cleanText(
      content
        .map((part) => {
          if (typeof part === 'string') {
            return part;
          }
          if (part && typeof part.text === 'string') {
            return part.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n'),
    );
  }
  return '';
}

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
  const apiPrompt = promptBuilder({ prompt, summary, mode, memory });

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
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

    const payload = await response.json();
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
    if (error?.name === 'AbortError') {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function runKimiApiPlan(options = {}) {
  return runKimiApiText({
    ...options,
    promptBuilder: buildKimiApiPlanPrompt,
    resultMode: options.mode === 'code' ? 'code' : 'cowork',
  });
}

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
export async function runKimiApiChatStream({
  prompt,
  summary = '',
  memory = '',
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
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
      body: JSON.stringify({
        model: String(model || DEFAULT_MODEL),
        messages: [{ role: 'user', content: apiPrompt }],
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
          const json = JSON.parse(data);
          const choiceDelta = json && json.choices && json.choices[0] ? (json.choices[0].delta || {}) : {};
          const reasoning = choiceDelta.reasoning_content || '';
          if (reasoning && typeof onReasoning === 'function') onReasoning(reasoning);
          const delta = choiceDelta.content || '';
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
    if (error && error.name === 'AbortError') {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
