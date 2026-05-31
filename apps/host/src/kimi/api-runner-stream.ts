// Kimi API 流式聊天(host · L1 领域层):OpenAI-compatible SSE 解析与 token 回调。

import {
  cleanProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  KIMI_API_NOT_CONFIGURED_MESSAGE,
} from './api-runner-config.js';
import { buildKimiApiChatPrompt } from './api-runner-prompts.js';
import type { PromptOptions } from './api-runner-prompts.js';

type KimiPayload = {
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
};
type StreamReadResult = { value?: Uint8Array; done?: boolean };
type StreamReader = { read(): Promise<StreamReadResult> };
type StreamBody = { getReader?: () => StreamReader };
type FetchResponse = { ok: boolean; status: number; body?: StreamBody | null };
type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<FetchResponse> | FetchResponse;

export type KimiStreamResult = {
  ok: true;
  provider: string;
  model: string;
  mode: 'chat';
  text: string;
  durationMs: number;
};
export type KimiStreamOptions = PromptOptions & {
  systemMessage?: string;
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  provider?: unknown;
  timeoutMs?: unknown;
  maxTokens?: unknown;
  fetchImpl?: FetchLike;
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  signal?: AbortSignal;
  userAgent?: unknown;
  temperature?: unknown;
};

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

/** 流式聊天:stream:true 调用并逐块解析 SSE,通过 onToken/onReasoning 回调增量推送,返回累计文本。 */
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
  fetchImpl = globalThis.fetch as unknown as FetchLike,
  onToken,
  onReasoning,
  signal,
  userAgent,
  temperature,
}: KimiStreamOptions = {}): Promise<KimiStreamResult> {
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
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (userAgent) headers['user-agent'] = String(userAgent);
    const numericTemperature = Number(temperature);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: String(model || DEFAULT_MODEL),
        // Prepend env/date grounding so simple chat answers time-sensitive questions correctly.
        messages: systemMessage
          ? [{ role: 'system', content: String(systemMessage) }, { role: 'user', content: apiPrompt }]
          : [{ role: 'user', content: apiPrompt }],
        ...(Number.isFinite(numericTemperature) ? { temperature: numericTemperature } : {}),
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
          const json = JSON.parse(data) as KimiPayload;
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
    if (isAbortError(error)) {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
