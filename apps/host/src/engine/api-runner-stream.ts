// Kimi API 流式聊天(host · L1 领域层 · engine)
// ---------------------------------------------------------------------------
// 职责:对 OpenAI 兼容的 /chat/completions 端点发起 stream:true 请求,逐块解析 SSE,
//       通过 onToken/onReasoning 回调增量推送正文与思考内容,并处理超时/中止。
// 依赖:同层 kimi(api-runner-config 默认值/常量、api-runner-prompts 拼接提示)。
//       导出:ModelStreamResult, ModelStreamOptions, runModelApiChatStream。

import {
  cleanProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MODEL_API_NOT_CONFIGURED_MESSAGE,
} from './api-runner-config.js';
import { buildModelApiChatPrompt } from './api-runner-prompts.js';
import type { PromptOptions } from './api-runner-prompts.js';
import { decideEgressPolicy, enforceRecordedEgressDecision } from '../security/egress-gateway.js';
import { callProviderChatCompletion } from './provider/index.js';
import { providerRequiresApiKey } from './provider/catalog.js';

type FetchResponse = {
  ok: boolean;
  status: number;
  body?: { getReader?: () => { read(): Promise<{ value?: BufferSource; done?: boolean }> } } | null;
  json?: () => Promise<unknown> | unknown;
};
type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<FetchResponse> | FetchResponse;

export type ModelStreamResult = {
  ok: true;
  provider: string;
  model: string;
  mode: 'chat';
  text: string;
  durationMs: number;
  usage?: unknown;
};
export type ModelStreamOptions = PromptOptions & {
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
export async function runModelApiChatStream({
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
}: ModelStreamOptions = {}): Promise<ModelStreamResult> {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Kimi API calls');
  }
  if (providerRequiresApiKey(provider) && (typeof apiKey !== 'string' || !apiKey.trim())) {
    throw new Error(MODEL_API_NOT_CONFIGURED_MESSAGE);
  }
  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const apiPrompt = buildModelApiChatPrompt({ prompt, summary, memory });
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
  const abortFromCaller = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  try {
    const numericTemperature = Number(temperature);
    const result = await callProviderChatCompletion({
      messages,
      tools: [],
      stream: true,
      modelConfig: {
        provider: cleanProvider(provider),
        apiKey: typeof apiKey === 'string' ? apiKey : '',
        baseUrl: String(baseUrl || DEFAULT_BASE_URL),
        model: String(model || DEFAULT_MODEL),
        maxTokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
        ...(Number.isFinite(numericTemperature) ? { temperature: numericTemperature } : {}),
        ...(userAgent ? { userAgent: String(userAgent) } : {}),
        securityMode,
      },
      fetchImpl: fetchImpl as never,
      signal: controller.signal,
      ...(onToken ? { onContent: onToken } : {}),
      ...(onReasoning ? { onReasoning } : {}),
    });
    return {
      ok: true,
      provider: result.provider || cleanProvider(provider),
      model: result.model || String(model || DEFAULT_MODEL),
      mode: 'chat',
      text: result.content,
      durationMs: Date.now() - startedAt,
      usage: result.usage,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abortFromCaller);
  }
}
