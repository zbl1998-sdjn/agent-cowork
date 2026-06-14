// 运行追踪·脱敏器(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:run-trace 的取值清洗与脱敏——递归处理对象/数组,抹掉密钥字段,保证 trace 可安全展示/存储。
// 依赖:L0 redaction。导出:sanitizeValue 等。
import { redactText } from '../security/redaction.js';

const SECRET_KEY_RE = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)/i;

/**
 * 判断值是否是可递归遍历的普通对象。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把可选值转成非空文本;空值返回 undefined 便于后续省略字段。
 */
export function nonEmptyText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

/**
 * 对 trace 文本脱敏并按字符上限裁剪,同时返回是否发生截断。
 */
export function sanitizeText(text: string, maxChars: number): { value: string; truncated: boolean } {
  const redacted = redactText(text) || '';
  if (redacted.length <= maxChars) {
    return { value: redacted, truncated: false };
  }
  return {
    value: `${redacted.slice(0, Math.max(0, maxChars - 18)).trim()} ...[truncated]`,
    truncated: true,
  };
}

/**
 * 递归清洗 trace 值:敏感键抹除、文本脱敏裁剪、函数/undefined 省略。
 */
export function sanitizeValue(value: unknown, options: { maxTextChars: number; key?: string }): { value: unknown; truncated: boolean } {
  const { maxTextChars, key = '' } = options;
  if (value === undefined || typeof value === 'function') {
    return { value: undefined, truncated: false };
  }
  if (SECRET_KEY_RE.test(key) && value !== undefined && value !== null && value !== '') {
    return { value: '[REDACTED]', truncated: false };
  }
  if (typeof value === 'string') {
    return sanitizeText(value, maxTextChars);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { value, truncated: false };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const items: unknown[] = [];
    for (const item of value) {
      const sanitized = sanitizeValue(item, { maxTextChars });
      if (sanitized.value !== undefined) items.push(sanitized.value);
      truncated = truncated || sanitized.truncated;
    }
    return { value: items, truncated };
  }
  if (isRecord(value)) {
    let truncated = false;
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeValue(childValue, { maxTextChars, key: childKey });
      if (sanitized.value !== undefined) out[childKey] = sanitized.value;
      truncated = truncated || sanitized.truncated;
    }
    return { value: out, truncated };
  }
  return sanitizeText(String(value), maxTextChars);
}

/**
 * 尝试把字符串解析成 JSON;失败时保留原值,供后续以 raw 形式记录。
 */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 解析并清洗工具参数;非对象参数统一包进 raw,避免 trace 结构漂移。
 */
export function parseToolArgs(value: unknown, maxTextChars: number): Record<string, unknown> {
  const parsed = parseMaybeJson(value === undefined ? {} : value);
  if (isRecord(parsed)) {
    return (sanitizeValue(parsed, { maxTextChars }).value || {}) as Record<string, unknown>;
  }
  const sanitized = sanitizeValue(parsed, { maxTextChars });
  return { raw: sanitized.value, parseError: 'invalid_json' };
}

/**
 * 归一化单次工具调用,兼容 OpenAI tool_call 与本地简化字段。
 */
export function normalizeToolCall(call: unknown, maxTextChars: number): { callId: string | undefined; tool: string; args: Record<string, unknown> } {
  const source = isRecord(call) ? call : {};
  const fn = isRecord(source.function) ? source.function : {};
  const tool = nonEmptyText(fn.name || source.name || source.tool) || 'unknown';
  return {
    callId: nonEmptyText(source.id || source.callId || source.tool_call_id),
    tool,
    args: parseToolArgs(source.args ?? source.arguments ?? fn.arguments ?? {}, maxTextChars),
  };
}

/**
 * 归一化工具定义列表,只保留名称、描述和参数 schema 的安全快照。
 */
export function normalizeTools(tools: unknown, maxTextChars: number): unknown[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const source = isRecord(tool) ? tool : {};
    const fn = isRecord(source.function) ? source.function : source;
    const normalized = {
      name: nonEmptyText(fn.name || source.name) || 'unknown',
      description: nonEmptyText(fn.description),
      parameters: fn.parameters,
    };
    return sanitizeValue(normalized, { maxTextChars }).value;
  }).filter((tool) => tool !== undefined);
}
