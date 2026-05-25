// @ts-check
import crypto from 'node:crypto';
import { redactText } from '../security/redaction.js';

const SENSITIVE_KEY_RE = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|authorization|credential)/i;
const MAX_OBJECT_DEPTH = 4;
const MAX_ARRAY_ITEMS = 25;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function objectAt(source, key) {
  const value = source[key];
  return isRecord(value) ? value : {};
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return value == null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function nullableText(value) {
  const valueText = text(value).trim();
  return valueText ? valueText : null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function sanitizeConfigValue(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeConfigValue(item, depth + 1));
  }
  if (!isRecord(value)) return text(value);
  if (depth >= MAX_OBJECT_DEPTH) return '[TRUNCATED]';
  const out = /** @type {Record<string, unknown>} */ ({});
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : sanitizeConfigValue(item, depth + 1);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function configSnapshot(record) {
  const snapshot = objectAt(record, 'configSnapshot');
  return /** @type {Record<string, unknown>} */ (sanitizeConfigValue(snapshot));
}

/**
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
function inputPrompt(record) {
  const input = objectAt(record, 'input');
  return text(input.prompt || record.prompt);
}

/**
 * @param {Record<string, unknown>} record
 * @returns {string | null}
 */
function modelBaseUrl(record) {
  const config = objectAt(record, 'configSnapshot');
  return nullableText(record.baseUrl || config.baseUrl);
}

/**
 * @param {unknown} record
 * @returns {{ schemaVersion: 1, prompt: { inputSha256: string | null, inputChars: number, systemPromptVersion: string | null, builder: string | null }, model: { provider: string | null, model: string | null, mode: string | null, baseUrl: string | null }, config: Record<string, unknown> }}
 */
export function buildRunAttribution(record) {
  const source = isRecord(record) ? record : {};
  const promptMeta = objectAt(source, 'promptAttribution');
  const result = objectAt(source, 'result');
  const promptText = inputPrompt(source);
  return {
    schemaVersion: 1,
    prompt: {
      inputSha256: promptText ? sha256(promptText) : null,
      inputChars: promptText.length,
      systemPromptVersion: nullableText(source.systemPromptVersion || promptMeta.systemPromptVersion),
      builder: nullableText(source.promptBuilder || promptMeta.builder),
    },
    model: {
      provider: nullableText(source.provider || result.provider),
      model: nullableText(source.model || result.model),
      mode: nullableText(source.mode || result.mode),
      baseUrl: modelBaseUrl(source),
    },
    config: configSnapshot(source),
  };
}

/**
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
export function withRunAttribution(record) {
  return {
    ...record,
    attribution: buildRunAttribution(record),
  };
}
