import { parseOpenAiCompatibleStream } from './kimi.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function providerMessage(id, message) {
  return message || `未配置 ${id} 模型提供商。请配置 baseUrl、model 和 API key 后重试。`;
}

function jsonMessage(payload) {
  const message = payload?.choices?.[0]?.message || { content: '' };
  return {
    ...message,
    usage: payload?.usage || message.usage,
  };
}

export function createOpenAiCompatibleProvider({
  id = 'openai-compatible',
  defaultBaseUrl = '',
  requiresApiKey = true,
  notConfiguredMessage = '',
} = {}) {
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
    }) {
      const config = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {};
      const apiKey = String(config.apiKey || '').trim();
      const baseUrl = trimBaseUrl(config.baseUrl || defaultBaseUrl);
      const model = String(config.model || '').trim();
      if (!baseUrl || !model || (requiresApiKey && !apiKey)) {
        throw new Error(providerMessage(id, notConfiguredMessage));
      }
      if (typeof fetchImpl !== 'function') {
        throw new Error('fetch is not available for model provider calls');
      }
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      if (config.userAgent) headers['user-agent'] = config.userAgent;
      const body = {
        model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: config.maxTokens || 2048,
        stream: true,
      };
      if (Number.isFinite(config.temperature)) body.temperature = config.temperature;
      const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        throw new Error(`${id} request failed with status ${resp.status}`);
      }
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      const message = reader
        ? await parseOpenAiCompatibleStream(reader, { onContent, onReasoning })
        : jsonMessage(await resp.json());
      return {
        ...message,
        provider: id,
        model,
      };
    },
  };
}

export function createOpenAiProvider() {
  return createOpenAiCompatibleProvider({
    id: 'openai',
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    requiresApiKey: true,
    notConfiguredMessage: '未配置 OpenAI API Key。请配置 OPENAI_API_KEY 或在设置中提供 key 后重试。',
  });
}

export function createLocalOpenAiCompatibleProvider() {
  return createOpenAiCompatibleProvider({
    id: 'openai/local',
    requiresApiKey: false,
    notConfiguredMessage: '未配置本地 OpenAI-compatible 模型。请配置本地 baseUrl 与 model 后重试。',
  });
}
