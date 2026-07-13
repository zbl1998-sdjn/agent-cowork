// Kimi API 直答运行器:OpenAI 兼容的 chat/completions 调用(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:发起非流式 /chat/completions 请求,处理超时中止、提取回复文本;
//       流式聊天实现拆在 api-runner-stream.ts,本文件保持公开兼容导出。
import {
  cleanProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  KIMI_API_NOT_CONFIGURED_MESSAGE,
} from './api-runner-config.js';
import { buildKimiApiChatPrompt, buildKimiApiPlanPrompt } from './api-runner-prompts.js';
import type { PromptOptions } from './api-runner-prompts.js';
import { decideEgressPolicy, enforceRecordedEgressDecision } from '../security/egress-gateway.js';
import { callProviderChatCompletion } from './provider/index.js';
import { providerRequiresApiKey } from './provider/catalog.js';

export { KIMI_API_NOT_CONFIGURED_MESSAGE, resolveKimiApiConfig } from './api-runner-config.js';
export { buildKimiApiChatPrompt, buildKimiApiPlanPrompt } from './api-runner-prompts.js';
export { runKimiApiChatStream } from './api-runner-stream.js';

type FetchResponse = {
  ok: boolean;
  status: number;
  body?: { getReader?: () => { read(): Promise<{ value?: BufferSource; done?: boolean }> } } | null;
  json(): Promise<unknown> | unknown;
};
type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<FetchResponse> | FetchResponse;

export type KimiTextResult = {
  ok: true;
  provider: string;
  model: string;
  mode: string;
  text: string;
  durationMs: number;
  usage?: unknown;
};
export type KimiTextOptions = PromptOptions & {
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
  userAgent?: unknown;
  temperature?: unknown;
  promptBuilder?: (options: PromptOptions) => string;
  resultMode?: string;
};

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

/** 非流式直答核心:校验 key/fetch、超时中止、发请求并返回规范化文本结果。 */
async function runKimiApiText({
  prompt,
  summary,
  mode,
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
  userAgent,
  temperature,
  promptBuilder,
  resultMode,
}: KimiTextOptions = {}): Promise<KimiTextResult> {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for Kimi API calls');
  }
  if (typeof promptBuilder !== 'function') {
    throw new Error('promptBuilder is required');
  }
  if (providerRequiresApiKey(provider) && (typeof apiKey !== 'string' || !apiKey.trim())) {
    throw new Error(KIMI_API_NOT_CONFIGURED_MESSAGE);
  }

  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const apiPrompt = promptBuilder({ prompt, summary, mode, memory });
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
  try {
    const numericTemperature = Number(temperature);
    const result = await callProviderChatCompletion({
      messages,
      tools: [],
      stream: resultMode === 'chat',
      kimiConfig: {
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
    });
    const text = result.content;
    if (!text) {
      throw new Error('Model provider returned empty output');
    }
    return {
      ok: true,
      provider: result.provider || cleanProvider(provider),
      model: result.model || String(model || DEFAULT_MODEL),
      mode: resultMode || (mode === 'code' ? 'code' : 'cowork'),
      text,
      durationMs: Date.now() - startedAt,
      usage: result.usage || null,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Kimi API timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 计划模式直答:用 plan 提示构造器走非流式调用。 */
export function runKimiApiPlan(options: KimiTextOptions = {}): Promise<KimiTextResult> {
  return runKimiApiText({
    ...options,
    promptBuilder: buildKimiApiPlanPrompt,
    resultMode: options.mode === 'code' ? 'code' : 'cowork',
  });
}

/** 聊天模式直答:用 chat 提示构造器走非流式调用。 */
export function runKimiApiChat(options: KimiTextOptions = {}): Promise<KimiTextResult> {
  return runKimiApiText({
    ...options,
    promptBuilder: buildKimiApiChatPrompt,
    resultMode: 'chat',
  });
}
