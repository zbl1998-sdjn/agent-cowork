// OpenAI 兼容提供商工厂(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:用一份可参数化的工厂(baseUrl/是否需要 key/未配置文案)派生出多家
//       OpenAI 兼容提供商——官方 OpenAI 与本地推理服务皆复用同一实现。
// 依赖:同层 kimi.js 的 parseOpenAiCompatibleStream;其余仅标准库。
// 导出:createOpenAiCompatibleProvider(通用工厂)、createOpenAiProvider、
//       createLocalOpenAiCompatibleProvider(供注册表登记)。
import type { ModelConfig, Provider, ProviderChatArgs, ProviderChatResult } from './types.js';
import { parseOpenAiCompatibleStream } from './kimi.js';
import { omitUndefined } from '../../util/object.js';
import { providerChatResultFromMessage } from './result.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

type ProviderOptions = {
  id?: string;
  defaultBaseUrl?: string;
  requiresApiKey?: boolean;
  notConfiguredMessage?: string;
};
type StreamReader = { read(): Promise<{ value?: BufferSource; done?: boolean }> };
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  body?: { getReader?: () => StreamReader } | null;
  json(): Promise<unknown>;
}>;

function trimBaseUrl(baseUrl: unknown): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function providerMessage(id: string, message: string): string {
  return message || `未配置 ${id} 模型提供商。请配置 baseUrl、model 和 API key 后重试。`;
}

function jsonMessage(payload: unknown): ProviderChatResult {
  const body = payload && typeof payload === 'object'
    ? payload as { choices?: Array<{ message?: Record<string, unknown> & { usage?: unknown } }>; usage?: unknown }
    : {};
  const message = body.choices?.[0]?.message || { content: '' };
  return providerChatResultFromMessage(message, body.usage || message.usage);
}
/** 派生一个 OpenAI 兼容 Provider(参数化 id/baseUrl/是否需要 key/未配置文案)。 */
export function createOpenAiCompatibleProvider({
  id = 'openai-compatible',
  defaultBaseUrl = '',
  requiresApiKey = true,
  notConfiguredMessage = '',
}: ProviderOptions = {}): Provider {
  return {
    id,
    async chatCompletion({
      messages,
      tools,
      kimiConfig,
      fetchImpl = globalThis.fetch,
      onContent,
      onReasoning,
      signal,
      promptCacheKey,
    }: ProviderChatArgs): Promise<ProviderChatResult> {
      const config: ModelConfig = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {};
      const apiKey = String(config.apiKey || '').trim();
      const baseUrl = trimBaseUrl(config.baseUrl || defaultBaseUrl);
      const model = String(config.model || '').trim();
      if (!baseUrl || !model || (requiresApiKey && !apiKey)) {
        throw new Error(providerMessage(id, notConfiguredMessage));
      }
      if (typeof fetchImpl !== 'function') {
        throw new Error('fetch is not available for model provider calls');
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      if (config.userAgent) headers['user-agent'] = String(config.userAgent);
      const body: Record<string, unknown> = {
        model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: config.maxTokens || 2048,
        stream: true,
        // 稳定缓存键(通常为 session/run id):提高前缀缓存命中率;不支持的后端会忽略。
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      };
      if (typeof config.temperature === 'number' && Number.isFinite(config.temperature)) {
        body.temperature = config.temperature;
      }
      const fetcher = fetchImpl as FetchLike;
      const resp = await fetcher(`${baseUrl}/chat/completions`, omitUndefined({
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      }));
      if (!resp.ok) {
        throw new Error(`${id} request failed with status ${resp.status}`);
      }
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      const message = reader
        ? await parseOpenAiCompatibleStream(reader, omitUndefined({ onContent, onReasoning }))
        : jsonMessage(await resp.json());
      return {
        ...message,
        provider: id,
        model,
      };
    },
  };
}

/** 派生官方 OpenAI 提供商(默认官方 baseUrl,必须配置 API key)。 */
export function createOpenAiProvider(): Provider {
  return createOpenAiCompatibleProvider({
    id: 'openai',
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    requiresApiKey: true,
    notConfiguredMessage: '未配置 OpenAI API Key。请配置 OPENAI_API_KEY 或在设置中提供 key 后重试。',
  });
}

/** 派生本地 OpenAI 兼容提供商(自定义 baseUrl,免 API key)。 */
export function createLocalOpenAiCompatibleProvider(): Provider {
  return createOpenAiCompatibleProvider({
    id: 'openai/local',
    requiresApiKey: false,
    notConfiguredMessage: '未配置本地 OpenAI-compatible 模型。请配置本地 baseUrl 与 model 后重试。',
  });
}
