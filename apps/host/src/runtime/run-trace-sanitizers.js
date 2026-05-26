// @ts-check
import { redactText } from '../security/redaction.js';

const SECRET_KEY_RE = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)/i;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function nonEmptyText(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ value: string, truncated: boolean }}
 */
export function sanitizeText(text, maxChars) {
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
 * @param {unknown} value
 * @param {{ maxTextChars: number, key?: string }} options
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function sanitizeValue(value, options) {
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
    const items = [];
    for (const item of value) {
      const sanitized = sanitizeValue(item, { maxTextChars });
      if (sanitized.value !== undefined) items.push(sanitized.value);
      truncated = truncated || sanitized.truncated;
    }
    return { value: items, truncated };
  }
  if (isRecord(value)) {
    let truncated = false;
    /** @type {Record<string, unknown>} */
    const out = {};
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
 * @param {unknown} value
 * @returns {unknown}
 */
export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * @param {unknown} value
 * @param {number} maxTextChars
 * @returns {Record<string, unknown>}
 */
export function parseToolArgs(value, maxTextChars) {
  const parsed = parseMaybeJson(value === undefined ? {} : value);
  if (isRecord(parsed)) {
    return /** @type {Record<string, unknown>} */ (sanitizeValue(parsed, { maxTextChars }).value || {});
  }
  const sanitized = sanitizeValue(parsed, { maxTextChars });
  return { raw: sanitized.value, parseError: 'invalid_json' };
}

/**
 * @param {unknown} call
 * @param {number} maxTextChars
 * @returns {{ callId: string | undefined, tool: string, args: Record<string, unknown> }}
 */
export function normalizeToolCall(call, maxTextChars) {
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
 * @param {unknown} tools
 * @param {number} maxTextChars
 * @returns {unknown[]}
 */
export function normalizeTools(tools, maxTextChars) {
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
