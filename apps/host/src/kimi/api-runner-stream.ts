// Kimi API 流式聊天(host · L1 领域层 · kimi)
// ---------------------------------------------------------------------------
// 职责:对 OpenAI 兼容的 /chat/completions 端点发起 stream:true 请求,逐块解析 SSE,
//       通过 onToken/onReasoning 回调增量推送正文与思考内容,并处理超时/中止。
// 依赖:同层 kimi(api-runner-config 默认值/常量、api-runner-prompts 拼接提示)。
//       导出:KimiStreamResult, KimiStreamOptions, runKimiApiChatStream。

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
import { createModelEndpointFetch } from '../security/model-endpoint-request.js';
import { decideEgressPolicy, enforceRecordedEgressDecision } from '../security/egress-gateway.js';

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
  trustedRoot?: unknown;
  securityMode?: unknown;
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
  trustedRoot,
  securityMode,
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
  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const apiPrompt = buildKimiApiChatPrompt({ prompt, summary, memory });
  const messages = systemMessage
    ? [{ role: 'system', content: String(systemMessage) }, { role: 'user', content: apiPrompt }]
    : [{ role: 'user', content: apiPrompt }];
  enforceRecordedEgressDecision(trustedRoot, decideEgressPolicy({
    kind: 'model_inference',
    destination: endpoint,
    provider,
    model,
    baseUrl,
    securityMode,
    content: messages,
  }));

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const modelFetch = createModelEndpointFetch({ provider, baseUrl, model }, {
    fetchImpl: fetchImpl as never,
  });
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
    const response = await modelFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: String(model || DEFAULT_MODEL),
        // 简单 chat 也前置 env/date grounding,确保时间敏感问题按真实环境回答。
        messages,
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
    let streamDone = false;
    const processSseLine = (rawLine: string): void => {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        buffer = '';
        streamDone = true;
        return;
      }
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
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) processSseLine(buffer);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processSseLine(line);
        if (streamDone) break;
      }
      if (streamDone) break;
    }
    return { ok: true, provider: cleanProvider(provider), model: String(model || DEFAULT_MODEL), mode: 'chat', text, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
