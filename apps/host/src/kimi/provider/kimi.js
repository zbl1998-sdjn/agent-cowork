// @ts-check

// Kimi 提供商适配 + OpenAI 兼容流解析(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:对 Kimi(OpenAI 兼容)发起流式 chat/completions,并提供被本目录其它
//       OpenAI 兼容提供商共用的 SSE 解析器(含流中断时部分工具调用的拆分)。
// 依赖:上层常量 ../api-runner.js(未配置文案);其余仅标准库。
// 导出:createKimiProvider(工厂,供注册表登记)、parseOpenAiCompatibleStream(共用流解析)。
import { KIMI_API_NOT_CONFIGURED_MESSAGE } from '../api-runner.js';

/**
 * @typedef {Record<string, unknown> & { apiKey?: unknown, baseUrl?: unknown, model?: unknown, maxTokens?: unknown, temperature?: unknown, userAgent?: unknown }} ModelConfig
 * @typedef {{ messages?: unknown[], tools?: unknown[], kimiConfig?: ModelConfig, fetchImpl?: unknown, onContent?: (delta: string) => void, onReasoning?: (delta: string) => void, signal?: AbortSignal }} ProviderChatArgs
 * @typedef {{ id?: string, type?: string, index?: number, function?: { name?: string, arguments?: string } }} StreamToolCallDelta
 * @typedef {{ id: string, type: string, function: { name: string, arguments: string } }} ToolCall
 * @typedef {{ executable: ToolCall[], partial: ToolCall[] }} SplitToolCalls
 * @typedef {{ read(): Promise<{ value?: BufferSource, done?: boolean }> }} StreamReader
 * @typedef {{ onContent?: (delta: string) => void, onReasoning?: (delta: string) => void }} StreamHandlers
 */

/** 创建 Kimi Provider:暴露 id 与 chatCompletion,供注册表登记与路由调用。 */
export function createKimiProvider() {
  return {
    id: 'kimi',
    /** @param {ProviderChatArgs} args */
    async chatCompletion({
      messages,
      tools,
      kimiConfig,
      fetchImpl = globalThis.fetch,
      onContent,
      onReasoning,
      signal,
    }) {
      if (!kimiConfig || !kimiConfig.apiKey) {
        throw new Error(KIMI_API_NOT_CONFIGURED_MESSAGE);
      }
      const endpoint = `${String(kimiConfig.baseUrl).replace(/\/+$/, '')}/chat/completions`;
      /** @type {Record<string, string>} */
      const headers = {
        authorization: `Bearer ${kimiConfig.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
      if (kimiConfig.userAgent) headers['user-agent'] = String(kimiConfig.userAgent);
      /** @type {Record<string, unknown>} */
      const body = {
        model: kimiConfig.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: kimiConfig.maxTokens || 2048,
        stream: true,
        // OpenAI-compatible providers only emit `usage` on the final SSE chunk
        // when `stream_options.include_usage` is set. Without this flag every
        // run records prompt/completion/total_tokens = 0 — which is what the
        // Observability panel was correctly showing as empty.
        stream_options: { include_usage: true },
      };
      if (Number.isFinite(kimiConfig.temperature)) body.temperature = /** @type {number} */ (kimiConfig.temperature);
      const fetcher = /** @type {typeof fetch} */ (fetchImpl);
      const resp = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!resp.ok) {
        throw new Error(`Kimi API request failed with status ${resp.status}`);
      }
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      if (!reader) {
        const json = /** @type {{ choices?: Array<{ message?: unknown }> }} */ (await resp.json());
        return (json.choices && json.choices[0] && json.choices[0].message) || { content: '' };
      }
      return parseOpenAiCompatibleStream(reader, { onContent, onReasoning });
    },
  };
}

/** @param {unknown} call */
function hasCompleteToolCallArguments(call) {
  const item = /** @type {Partial<ToolCall>} */ (call && typeof call === 'object' ? call : {});
  const fn = /** @type {ToolCall['function']} */ (item.function || {});
  const raw = typeof fn.arguments === 'string' ? fn.arguments.trim() : '';
  if (!fn.name || !raw) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** @param {ToolCall[]} calls @param {boolean} interrupted @returns {SplitToolCalls} */
function splitInterruptedToolCalls(calls, interrupted) {
  if (!interrupted) return { executable: calls, partial: [] };
  /** @type {ToolCall[]} */
  const executable = [];
  /** @type {ToolCall[]} */
  const partial = [];
  for (const call of calls) {
    if (hasCompleteToolCallArguments(call)) executable.push(call);
    else partial.push(call);
  }
  return { executable, partial };
}

/** 解析 OpenAI 兼容 SSE 流,累积正文/思考/工具调用/用量;读流出错且已有内容时标记中断而非丢弃。 @param {StreamReader} reader @param {StreamHandlers} [handlers] */
export async function parseOpenAiCompatibleStream(reader, { onContent, onReasoning } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  /** @type {unknown} */
  let usage = null;
  let interrupted = false;
  let streamError = '';
  /** @type {ToolCall[]} */
  const toolCalls = [];
  const hasAccumulated = () => !!(content || reasoning || usage || toolCalls.some(Boolean));
  const finish = () => {
    const calls = toolCalls.filter(Boolean);
    const { executable, partial } = splitInterruptedToolCalls(calls, interrupted);
    return {
      content,
      reasoning_content: reasoning || undefined,
      tool_calls: executable.length ? executable : undefined,
      partial_tool_calls: partial.length ? partial : undefined,
      usage,
      ...(interrupted ? {
        stream_interrupted: true,
        finish_reason: 'stream_interrupted',
        stream_error: streamError,
      } : {}),
    };
  };
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (!hasAccumulated()) throw err;
      interrupted = true;
      streamError = /** @type {{ message?: string }} */ (err && typeof err === 'object' ? err : {}).message || 'stream interrupted';
      break;
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      json = /** @type {{ usage?: unknown, choices?: Array<{ delta?: Record<string, unknown> }> }} */ (json && typeof json === 'object' ? json : {});
      if (json && json.usage) usage = json.usage;
      const delta = json && json.choices && json.choices[0] ? (json.choices[0].delta || {}) : {};
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
          const call = /** @type {StreamToolCallDelta} */ (tc && typeof tc === 'object' ? tc : {});
          const idx = call.index || 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: call.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
          }
          if (call.id) toolCalls[idx].id = call.id;
          if (call.function && call.function.name) toolCalls[idx].function.name = call.function.name;
          if (call.function && call.function.arguments) toolCalls[idx].function.arguments += call.function.arguments;
        }
      }
    }
    if (sawDone) break;
  }
  return finish();
}
