// Anthropic/Claude 提供商适配(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:把统一的 OpenAI 风格消息/工具转成 Anthropic Messages API 格式,发起
//       SSE 流式请求并解析回 { content, tool_calls, usage } 的统一结构。
// 依赖:仅标准库(fetch / TextDecoder)。
// 导出:parseAnthropicStream(流解析)、createAnthropicProvider(工厂,产出
//       带 id/chatCompletion 的 Provider,供注册表 index 登记)。
import { omitUndefined } from '../../util/object.js';
import type { ModelConfig, Provider, ProviderChatArgs } from './types.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

type ChatMessage = Record<string, unknown> & {
  role?: string;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown[];
};
type ChatTool = { function?: { name?: unknown; description?: unknown; parameters?: unknown } };
type ToolCallLike = { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
type AnthropicMessage = { role: string; content: unknown[] };
type AnthropicTool = { name: string; description: unknown; input_schema: unknown };
type AnthropicToolBlock = { index: number; id: string; type: string; function: { name: string; arguments: string } };
type UsageTotals = Record<string, number>;
type StreamReader = { read(): Promise<{ value?: BufferSource; done?: boolean }> };
type StreamHandlers = { onContent?: (delta: string) => void };
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

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    const value = part && typeof part === 'object' ? part as { text?: unknown; content?: unknown } : {};
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    return '';
  }).filter(Boolean).join('\n');
}

function parseArgs(raw: unknown): unknown {
  if (!raw) return {};
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

function toolArguments(input: unknown): string {
  return input && typeof input === 'object' && Object.keys(input).length > 0 ? JSON.stringify(input) : '';
}

function toAnthropicTool(tool: unknown): AnthropicTool {
  const value = tool && typeof tool === 'object' ? tool as ChatTool : {};
  const fn = value.function || {};
  return {
    name: String(fn.name || '').trim(),
    description: fn.description || '',
    input_schema: fn.parameters || { type: 'object' },
  };
}

/** 把统一消息列表转为 Anthropic 格式:system 抽出合并,tool 角色映射为 user 侧 tool_result。 */
function toAnthropicMessages(messages: unknown[] = []): { system?: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const item = msg as ChatMessage;
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
      const content: unknown[] = [];
      const text = textContent(item.content);
      if (text) content.push({ type: 'text', text });
      for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
        const toolCall = call && typeof call === 'object' ? call as ToolCallLike : {};
        const fn = toolCall.function || {};
        content.push({ type: 'tool_use', id: toolCall.id || `call_${content.length}`, name: fn.name || '', input: parseArgs(fn.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: textContent(item.content) }] });
  }
  return omitUndefined({ system: system.join('\n\n') || undefined, messages: out });
}

function mergeUsage(target: UsageTotals, usage: unknown = {}): void {
  const body = usage && typeof usage === 'object' ? usage as { input_tokens?: unknown; output_tokens?: unknown } : {};
  const input = Number(body.input_tokens || 0);
  const output = Number(body.output_tokens || 0);
  if (input) target.prompt_tokens = Math.max(target.prompt_tokens || 0, input);
  if (output) target.completion_tokens = Math.max(target.completion_tokens || 0, output);
  target.total_tokens = (target.prompt_tokens || 0) + (target.completion_tokens || 0);
}

function fromAnthropicMessage(payload: unknown): Record<string, unknown> {
  let content = '';
  const toolCalls: unknown[] = [];
  const body = payload && typeof payload === 'object' ? payload as { content?: unknown[]; usage?: unknown } : {};
  for (const rawPart of Array.isArray(body.content) ? body.content : []) {
    const part = rawPart && typeof rawPart === 'object' ? rawPart as Record<string, unknown> : {};
    if (part.type === 'text') content += String(part.text || '');
    if (part.type === 'tool_use') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
      });
    }
  }
  const usage: UsageTotals = {};
  mergeUsage(usage, body.usage);
  return { content, tool_calls: toolCalls.length ? toolCalls : undefined, usage };
}

/** 解析 Anthropic SSE 流,累积正文/工具调用/用量,聚合为统一消息结构。 */
export async function parseAnthropicStream(
  reader: StreamReader,
  { onContent }: StreamHandlers = {},
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const usage: UsageTotals = {};
  const toolBlocks = new Map<number, AnthropicToolBlock>();
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
      let json: Record<string, unknown>;
      try { json = JSON.parse(line.slice(5).trim()) as Record<string, unknown>; } catch { continue; }
      json = json && typeof json === 'object' ? json : {};
      const message = json.message && typeof json.message === 'object' ? json.message as { usage?: unknown } : {};
      mergeUsage(usage, json.usage || message.usage);
      const idx = Number(json.index || 0);
      const contentBlock = json.content_block && typeof json.content_block === 'object' ? json.content_block as Record<string, unknown> : {};
      const delta = json.delta && typeof json.delta === 'object' ? json.delta as Record<string, unknown> : {};
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

/** 创建 Anthropic Provider:暴露 id 与 chatCompletion,供注册表 index 登记。 */
export function createAnthropicProvider(): Provider {
  return {
    id: 'anthropic',
    async chatCompletion({ messages, tools, kimiConfig, fetchImpl = globalThis.fetch, onContent, signal }: ProviderChatArgs): Promise<Record<string, unknown>> {
      const config: ModelConfig = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {};
      const apiKey = String(config.apiKey || '').trim();
      const model = String(config.model || '').trim();
      const baseUrl = trimBaseUrl(config.baseUrl || DEFAULT_ANTHROPIC_BASE_URL);
      if (!apiKey || !model) throw new Error('未配置 Anthropic/Claude 模型。请配置 API key 与 model 后重试。');
      const converted = toAnthropicMessages(messages);
      const body: Record<string, unknown> = {
        model,
        messages: converted.messages,
        max_tokens: config.maxTokens || 2048,
        stream: true,
        ...(converted.system ? { system: converted.system } : {}),
      };
      const anthropicTools = (Array.isArray(tools) ? tools : []).map(toAnthropicTool).filter((tool) => tool.name);
      if (anthropicTools.length) body.tools = anthropicTools;
      if (typeof config.temperature === 'number' && Number.isFinite(config.temperature)) {
        body.temperature = config.temperature;
      }
      const fetcher = fetchImpl as FetchLike;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      };
      if (config.userAgent) headers['user-agent'] = String(config.userAgent);
      const resp = await fetcher(`${baseUrl}/messages`, omitUndefined({
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      }));
      if (!resp.ok) throw new Error(`anthropic request failed with status ${resp.status}`);
      const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
      const message = reader ? await parseAnthropicStream(reader, omitUndefined({ onContent })) : fromAnthropicMessage(await resp.json());
      return { ...message, provider: 'anthropic', model };
    },
  };
}
