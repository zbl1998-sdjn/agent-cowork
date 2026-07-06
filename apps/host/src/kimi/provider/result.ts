// Provider 结果归一化(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:把外部 provider 的 unknown JSON 响应收敛成 ProviderChatResult,让 unknown
//      停在集成边界内,不继续扩散到 agent/tool-loop/orchestrator。
import type { ProviderChatResult, ProviderToolCall, ProviderUsage } from './types.js';

type RawObject = Record<string, unknown>;

const NUMERIC_USAGE_FIELDS = new Set([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'prompt_cache_hit_tokens',
]);

function isObject(value: unknown): value is RawObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function providerTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!isObject(part)) return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('\n');
}

function primitiveUsageValue(value: unknown): number | string | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return undefined;
}

export function providerUsage(value: unknown): ProviderUsage | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const usage: ProviderUsage = {};
  for (const [key, raw] of Object.entries(value)) {
    if (NUMERIC_USAGE_FIELDS.has(key)) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) usage[key] = numeric;
      continue;
    }
    const primitive = primitiveUsageValue(raw);
    if (primitive !== undefined) usage[key] = primitive;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function providerToolCall(value: unknown, index: number): ProviderToolCall | null {
  if (!isObject(value)) return null;
  const fn = isObject(value.function) ? value.function : {};
  const name = typeof fn.name === 'string' ? fn.name : '';
  const rawArgs = fn.arguments;
  const args = typeof rawArgs === 'string'
    ? rawArgs
    : (rawArgs && typeof rawArgs === 'object' ? JSON.stringify(rawArgs) : '');
  if (!name && !args) return null;
  const call: ProviderToolCall = {
    function: { name, arguments: args },
  };
  call.id = typeof value.id === 'string' && value.id ? value.id : `call_${index}`;
  if (typeof value.type === 'string' && value.type) call.type = value.type;
  return call;
}

export function providerToolCalls(value: unknown): ProviderToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.map(providerToolCall).filter((call): call is ProviderToolCall => !!call);
  return calls.length ? calls : undefined;
}

export function providerChatResultFromMessage(message: unknown, fallbackUsage?: unknown): ProviderChatResult {
  const body = isObject(message) ? message : {};
  const result: ProviderChatResult = {
    content: providerTextContent(body.content),
  };
  if (typeof body.reasoning_content === 'string' && body.reasoning_content) {
    result.reasoning_content = body.reasoning_content;
  }
  const toolCalls = providerToolCalls(body.tool_calls);
  if (toolCalls) result.tool_calls = toolCalls;
  const partialToolCalls = providerToolCalls(body.partial_tool_calls);
  if (partialToolCalls) result.partial_tool_calls = partialToolCalls;
  const usage = providerUsage(body.usage ?? fallbackUsage);
  if (usage !== undefined) result.usage = usage;
  if (typeof body.provider === 'string' && body.provider) result.provider = body.provider;
  if (typeof body.model === 'string' && body.model) result.model = body.model;
  if (typeof body.finish_reason === 'string' && body.finish_reason) result.finish_reason = body.finish_reason;
  if (body.stream_interrupted === true) result.stream_interrupted = true;
  if (typeof body.stream_error === 'string' && body.stream_error) result.stream_error = body.stream_error;
  return result;
}