// Kimi 提供商适配 + OpenAI 兼容流解析(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:对 Kimi(OpenAI 兼容)发起流式 chat/completions,并提供被本目录其它
//       OpenAI 兼容提供商共用的 SSE 解析器(含流中断时部分工具调用的拆分)。
// 依赖:同层配置常量 ../api-runner-config.js(未配置文案);其余仅标准库。
// 导出:createKimiProvider(工厂,供注册表登记)、parseOpenAiCompatibleStream(共用流解析)。
import { MODEL_API_NOT_CONFIGURED_MESSAGE } from '../api-runner-config.js';
import { omitUndefined } from '../../util/object.js';
import type { Provider, ProviderChatArgs, ProviderChatResult, ProviderToolCall, ProviderUsage } from './types.js';
import { providerChatResultFromMessage, providerUsage } from './result.js';

type StreamToolCallDelta = {
  id?: string;
  type?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
};
type ToolCall = ProviderToolCall & { id: string; type: string };
type SplitToolCalls = { executable: ProviderToolCall[]; partial: ProviderToolCall[] };
type StreamReader = { read(): Promise<{ value?: BufferSource; done?: boolean }> };
type StreamHandlers = {
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
};
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  body?: { getReader?: () => StreamReader } | null;
  json(): Promise<unknown>;
}>;
type OpenAiStreamChunk = {
  usage?: unknown;
  choices?: Array<{ delta?: Record<string, unknown> }>;
};

/** 创建 Kimi Provider:暴露 id 与 chatCompletion,供注册表登记与路由调用。 */
export function createKimiProvider(): Provider {
  return {
    id: 'kimi',
    async chatCompletion({
      messages,
      tools,
      kimiConfig,
      fetchImpl = globalThis.fetch,
      onContent,
      onReasoning,
      signal,
      promptCacheKey,
      stream = true,
    }: ProviderChatArgs): Promise<ProviderChatResult> {
      if (!kimiConfig || !kimiConfig.apiKey) {
        throw new Error(MODEL_API_NOT_CONFIGURED_MESSAGE);
      }
      const endpoint = `${String(kimiConfig.baseUrl).replace(/\/+$/, '')}/chat/completions`;
      const headers: Record<string, string> = {
        authorization: `Bearer ${kimiConfig.apiKey}`,
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
      };
      if (kimiConfig.userAgent) headers['user-agent'] = String(kimiConfig.userAgent);
      const body: Record<string, unknown> = {
        model: kimiConfig.model,
        messages,
        ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: kimiConfig.maxTokens || 2048,
        stream,
        // OpenAI 兼容流只有设置 include_usage 才会在最终 SSE chunk 返回 usage。
        // 否则 run 记录的 token 用量会全为 0,观测面板也会显示为空。
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        // 稳定缓存键:官方建议多轮 agent 传入(通常为 session/run id),提高前缀缓存命中率。
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      };
      if (typeof kimiConfig.temperature === 'number' && Number.isFinite(kimiConfig.temperature)) {
        body.temperature = kimiConfig.temperature;
      }
      const fetcher = fetchImpl as FetchLike;
      const resp = await fetcher(endpoint, omitUndefined({ method: 'POST', headers, body: JSON.stringify(body), signal }));
      if (!resp.ok) {
        throw new Error(`Kimi API request failed with status ${resp.status}`);
      }
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      if (!reader) {
        const json = await resp.json() as { choices?: Array<{ message?: unknown }>; usage?: unknown };
        const message = json.choices && json.choices[0] && json.choices[0].message;
        return providerChatResultFromMessage(message, json.usage);
      }
      return parseOpenAiCompatibleStream(reader, omitUndefined({ onContent, onReasoning }));
    },
  };
}

function hasCompleteToolCallArguments(call: ProviderToolCall): boolean {
  const fn = call.function;
  const rawArgs = fn.arguments.trim();
  if (!fn.name || !rawArgs) return false;
  try {
    JSON.parse(rawArgs);
    return true;
  } catch {
    return false;
  }
}
function splitInterruptedToolCalls(calls: ToolCall[], interrupted: boolean): SplitToolCalls {
  if (!interrupted) return { executable: calls, partial: [] };
  const executable: ToolCall[] = [];
  const partial: ToolCall[] = [];
  for (const call of calls) {
    if (hasCompleteToolCallArguments(call)) executable.push(call);
    else partial.push(call);
  }
  return { executable, partial };
}

/** 解析 OpenAI 兼容 SSE 流,累积正文/思考/工具调用/用量;读流出错且已有内容时标记中断而非丢弃。 */
export async function parseOpenAiCompatibleStream(
  reader: StreamReader,
  { onContent, onReasoning }: StreamHandlers = {},
): Promise<ProviderChatResult> {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage: ProviderUsage | null | undefined;
  let interrupted = false;
  let streamError = '';
  const toolCalls: ToolCall[] = [];
  const hasAccumulated = () => !!(content || reasoning || usage || toolCalls.some(Boolean));
  const finish = () => {
    const calls = toolCalls.filter(Boolean);
    const { executable, partial } = splitInterruptedToolCalls(calls, interrupted);
    return {
      content,
      reasoning_content: reasoning || undefined,
      tool_calls: executable.length ? executable : undefined,
      partial_tool_calls: partial.length ? partial : undefined,
      ...(usage !== undefined ? { usage } : {}),
      ...(interrupted ? {
        stream_interrupted: true,
        finish_reason: 'stream_interrupted',
        stream_error: streamError,
      } : {}),
    };
  };
  for (;;) {
    let chunk: Awaited<ReturnType<StreamReader['read']>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (!hasAccumulated()) throw err;
      interrupted = true;
      streamError = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'stream interrupted';
      break;
    }
    const { value, done } = chunk;
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) buffer += '\n';
    } else {
      buffer += decoder.decode(value, { stream: true });
    }
    let nl;
    let sawDone = false;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        buffer = '';
        sawDone = true;
        break;
      }
      let json: OpenAiStreamChunk;
      try {
        json = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      json = json && typeof json === 'object' ? json : {};
      if (json.usage) usage = providerUsage(json.usage);
      const firstChoice = json.choices?.[0];
      const delta = firstChoice ? (firstChoice.delta || {}) : {};
      if (typeof delta.reasoning_content === 'string') {
        reasoning += delta.reasoning_content;
        if (typeof onReasoning === 'function') onReasoning(delta.reasoning_content);
      }
      if (typeof delta.content === 'string') {
        content += delta.content;
        if (typeof onContent === 'function') onContent(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const call = tc && typeof tc === 'object' ? tc as StreamToolCallDelta : {};
          const idx = call.index || 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: call.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
          }
          const current = toolCalls[idx];
          if (!current) continue;
          if (call.id) current.id = call.id;
          if (call.function && call.function.name) current.function.name = call.function.name;
          if (call.function && call.function.arguments) current.function.arguments += call.function.arguments;
        }
      }
    }
    if (sawDone || done) break;
  }
  return finish();
}
