// @ts-check
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * @typedef {Record<string, unknown> & { apiKey?: unknown, baseUrl?: unknown, model?: unknown, maxTokens?: unknown, temperature?: unknown, userAgent?: unknown }} ModelConfig
 * @typedef {Record<string, unknown> & { role?: string, content?: unknown, tool_call_id?: unknown, tool_calls?: unknown[] }} ChatMessage
 * @typedef {{ function?: { name?: unknown, description?: unknown, parameters?: unknown } }} ChatTool
 * @typedef {{ id?: unknown, function?: { name?: unknown, arguments?: unknown } }} ToolCallLike
 * @typedef {{ read(): Promise<{ value?: BufferSource, done?: boolean }> }} StreamReader
 * @typedef {{ onContent?: (delta: string) => void }} StreamHandlers
 * @typedef {{ index: number, id: string, type: string, function: { name: string, arguments: string } }} AnthropicToolBlock
 * @typedef {Record<string, number>} UsageTotals
 * @typedef {{ messages?: unknown[], tools?: unknown[], kimiConfig?: ModelConfig, fetchImpl?: unknown, onContent?: (delta: string) => void, signal?: AbortSignal }} ProviderChatArgs
 */

/** @param {unknown} baseUrl */
function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/** @param {unknown} content */
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    const value = /** @type {{ text?: unknown, content?: unknown }} */ (part && typeof part === 'object' ? part : {});
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    return '';
  }).filter(Boolean).join('\n');
}

/** @param {unknown} raw */
function parseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

/** @param {unknown} input */
function toolArguments(input) {
  return input && typeof input === 'object' && Object.keys(input).length > 0 ? JSON.stringify(input) : '';
}

/** @param {unknown} tool */
function toAnthropicTool(tool) {
  const value = /** @type {ChatTool} */ (tool && typeof tool === 'object' ? tool : {});
  const fn = value.function || {};
  return {
    name: String(fn.name || '').trim(),
    description: fn.description || '',
    input_schema: fn.parameters || { type: 'object' },
  };
}

/** @param {unknown[]} [messages] */
function toAnthropicMessages(messages = []) {
  /** @type {string[]} */
  const system = [];
  /** @type {Array<{ role: string, content: unknown[] }>} */
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const item = /** @type {ChatMessage} */ (msg);
    if (item.role === 'system') {
      const text = textContent(item.content);
      if (text) system.push(text);
      continue;
    }
    if (item.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: item.tool_call_id || 'tool_unknown', content: textContent(item.content) }],
      });
      continue;
    }
    if (item.role === 'assistant') {
      /** @type {unknown[]} */
      const content = [];
      const text = textContent(item.content);
      if (text) content.push({ type: 'text', text });
      for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
        const toolCall = /** @type {ToolCallLike} */ (call && typeof call === 'object' ? call : {});
        const fn = toolCall.function || {};
        content.push({ type: 'tool_use', id: toolCall.id || `call_${content.length}`, name: fn.name || '', input: parseArgs(fn.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: textContent(item.content) }] });
  }
  return { system: system.join('\n\n') || undefined, messages: out };
}

/** @param {UsageTotals} target @param {unknown} [usage] */
function mergeUsage(target, usage = {}) {
  const body = /** @type {{ input_tokens?: unknown, output_tokens?: unknown }} */ (usage && typeof usage === 'object' ? usage : {});
  const input = Number(body.input_tokens || 0);
  const output = Number(body.output_tokens || 0);
  if (input) target.prompt_tokens = Math.max(target.prompt_tokens || 0, input);
  if (output) target.completion_tokens = Math.max(target.completion_tokens || 0, output);
  target.total_tokens = (target.prompt_tokens || 0) + (target.completion_tokens || 0);
}

/** @param {unknown} payload */
function fromAnthropicMessage(payload) {
  let content = '';
  /** @type {unknown[]} */
  const toolCalls = [];
  const body = /** @type {{ content?: unknown[], usage?: unknown }} */ (payload && typeof payload === 'object' ? payload : {});
  for (const rawPart of Array.isArray(body.content) ? body.content : []) {
    const part = /** @type {Record<string, unknown>} */ (rawPart && typeof rawPart === 'object' ? rawPart : {});
    if (part.type === 'text') content += part.text || '';
    if (part.type === 'tool_use') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
      });
    }
  }
  /** @type {UsageTotals} */
  const usage = {};
  mergeUsage(usage, body.usage);
  return { content, tool_calls: toolCalls.length ? toolCalls : undefined, usage };
}

/** @param {StreamReader} reader @param {StreamHandlers} [handlers] */
export async function parseAnthropicStream(reader, { onContent } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  /** @type {UsageTotals} */
  const usage = {};
  /** @type {Map<number, AnthropicToolBlock>} */
  const toolBlocks = new Map();
  const finish = () => ({
    content,
    tool_calls: toolBlocks.size ? [...toolBlocks.values()].sort((a, b) => a.index - b.index).map(({ index: _index, ...call }) => call) : undefined,
    usage,
  });
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let json;
      try { json = JSON.parse(line.slice(5).trim()); } catch { continue; }
      json = /** @type {Record<string, unknown>} */ (json && typeof json === 'object' ? json : {});
      const message = /** @type {{ usage?: unknown }} */ (json.message && typeof json.message === 'object' ? json.message : {});
      mergeUsage(usage, json.usage || message.usage);
      const idx = Number(json.index || 0);
      const contentBlock = /** @type {Record<string, unknown>} */ (json.content_block && typeof json.content_block === 'object' ? json.content_block : {});
      const delta = /** @type {Record<string, unknown>} */ (json.delta && typeof json.delta === 'object' ? json.delta : {});
      if (json.type === 'content_block_start' && contentBlock.type === 'tool_use') {
        toolBlocks.set(idx, { index: idx, id: String(contentBlock.id || `toolu_${idx}`), type: 'function', function: { name: String(contentBlock.name || ''), arguments: toolArguments(contentBlock.input) } });
      } else if (json.type === 'content_block_delta' && delta.type === 'text_delta') {
        const text = typeof delta.text === 'string' ? delta.text : '';
        content += text;
        if (text && typeof onContent === 'function') onContent(text);
      } else if (json.type === 'content_block_delta' && delta.type === 'input_json_delta') {
        const block = toolBlocks.get(idx) || { index: idx, id: `toolu_${idx}`, type: 'function', function: { name: '', arguments: '' } };
        block.function.arguments += typeof delta.partial_json === 'string' ? delta.partial_json : '';
        toolBlocks.set(idx, block);
      }
    }
  }
  return finish();
}

export function createAnthropicProvider() {
  return {
    id: 'anthropic',
    /** @param {ProviderChatArgs} args */
    async chatCompletion({ messages, tools, kimiConfig, fetchImpl = globalThis.fetch, onContent, signal }) {
      const config = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {};
      const apiKey = String(config.apiKey || '').trim();
      const model = String(config.model || '').trim();
      const baseUrl = trimBaseUrl(config.baseUrl || DEFAULT_ANTHROPIC_BASE_URL);
      if (!apiKey || !model) throw new Error('未配置 Anthropic/Claude 模型。请配置 API key 与 model 后重试。');
      const converted = toAnthropicMessages(messages);
      /** @type {Record<string, unknown>} */
      const body = {
        model,
        messages: converted.messages,
        max_tokens: config.maxTokens || 2048,
        stream: true,
        ...(converted.system ? { system: converted.system } : {}),
      };
      const anthropicTools = (Array.isArray(tools) ? tools : []).map(toAnthropicTool).filter((tool) => tool.name);
      if (anthropicTools.length) body.tools = anthropicTools;
      if (Number.isFinite(config.temperature)) body.temperature = /** @type {number} */ (config.temperature);
      const fetcher = /** @type {typeof fetch} */ (fetchImpl);
      /** @type {Record<string, string>} */
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      };
      if (config.userAgent) headers['user-agent'] = String(config.userAgent);
      const resp = await fetcher(`${baseUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) throw new Error(`anthropic request failed with status ${resp.status}`);
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      const message = reader ? await parseAnthropicStream(reader, { onContent }) : fromAnthropicMessage(await resp.json());
      return { ...message, provider: 'anthropic', model };
    },
  };
}
