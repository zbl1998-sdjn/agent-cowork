const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    if (part && typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('\n');
}

function parseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function toolArguments(input) {
  return input && typeof input === 'object' && Object.keys(input).length > 0 ? JSON.stringify(input) : '';
}

function toAnthropicTool(tool) {
  const fn = tool && tool.function ? tool.function : {};
  return {
    name: String(fn.name || '').trim(),
    description: fn.description || '',
    input_schema: fn.parameters || { type: 'object' },
  };
}

function toAnthropicMessages(messages = []) {
  const system = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system') {
      const text = textContent(msg.content);
      if (text) system.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || 'tool_unknown', content: textContent(msg.content) }],
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const content = [];
      const text = textContent(msg.content);
      if (text) content.push({ type: 'text', text });
      for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        const fn = call && call.function ? call.function : {};
        content.push({ type: 'tool_use', id: call.id || `call_${content.length}`, name: fn.name || '', input: parseArgs(fn.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: textContent(msg.content) }] });
  }
  return { system: system.join('\n\n') || undefined, messages: out };
}

function mergeUsage(target, usage = {}) {
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  if (input) target.prompt_tokens = Math.max(target.prompt_tokens || 0, input);
  if (output) target.completion_tokens = Math.max(target.completion_tokens || 0, output);
  target.total_tokens = (target.prompt_tokens || 0) + (target.completion_tokens || 0);
}

function fromAnthropicMessage(payload) {
  let content = '';
  const toolCalls = [];
  for (const part of Array.isArray(payload?.content) ? payload.content : []) {
    if (part.type === 'text') content += part.text || '';
    if (part.type === 'tool_use') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
      });
    }
  }
  const usage = {};
  mergeUsage(usage, payload?.usage);
  return { content, tool_calls: toolCalls.length ? toolCalls : undefined, usage };
}

export async function parseAnthropicStream(reader, { onContent } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const usage = {};
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
      mergeUsage(usage, json.usage || json.message?.usage);
      const idx = Number(json.index || 0);
      if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
        const block = json.content_block;
        toolBlocks.set(idx, { index: idx, id: block.id, type: 'function', function: { name: block.name, arguments: toolArguments(block.input) } });
      } else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        content += json.delta.text || '';
        if (json.delta.text && typeof onContent === 'function') onContent(json.delta.text);
      } else if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta') {
        const block = toolBlocks.get(idx) || { index: idx, id: `toolu_${idx}`, type: 'function', function: { name: '', arguments: '' } };
        block.function.arguments += json.delta.partial_json || '';
        toolBlocks.set(idx, block);
      }
    }
  }
  return finish();
}

export function createAnthropicProvider() {
  return {
    id: 'anthropic',
    async chatCompletion({ messages, tools, kimiConfig, fetchImpl = globalThis.fetch, onContent, signal }) {
      const config = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {};
      const apiKey = String(config.apiKey || '').trim();
      const model = String(config.model || '').trim();
      const baseUrl = trimBaseUrl(config.baseUrl || DEFAULT_ANTHROPIC_BASE_URL);
      if (!apiKey || !model) throw new Error('未配置 Anthropic/Claude 模型。请配置 API key 与 model 后重试。');
      const converted = toAnthropicMessages(messages);
      const body = {
        model,
        messages: converted.messages,
        max_tokens: config.maxTokens || 2048,
        stream: true,
        ...(converted.system ? { system: converted.system } : {}),
      };
      const anthropicTools = (Array.isArray(tools) ? tools : []).map(toAnthropicTool).filter((tool) => tool.name);
      if (anthropicTools.length) body.tools = anthropicTools;
      if (Number.isFinite(config.temperature)) body.temperature = config.temperature;
      const resp = await fetchImpl(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...(config.userAgent ? { 'user-agent': config.userAgent } : {}),
        },
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
