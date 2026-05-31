// 运行归因(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:为运行记录补充「归因」上下文(租户/用户/trace 等)并对上下文做有界、脱敏的深拷贝(限深 4、限数组 25、
//       抹密钥),避免把敏感或超大对象写进 run 记录。依赖:L0 redaction。导出:withRunAttribution。
import crypto from 'node:crypto';
import { redactText } from '../security/redaction.js';

const SENSITIVE_KEY_RE = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|authorization|credential)/i;
const MAX_OBJECT_DEPTH = 4;
const MAX_ARRAY_ITEMS = 25;

/**
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 */
function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

/**
 */
function text(value: unknown): string {
  return value == null ? '' : String(value);
}

/**
 */
function nullableText(value: unknown): string | null {
  const valueText = text(value).trim();
  return valueText ? valueText : null;
}

/**
 */
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 */
function sanitizeConfigValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeConfigValue(item, depth + 1));
  }
  if (!isRecord(value)) return text(value);
  if (depth >= MAX_OBJECT_DEPTH) return '[TRUNCATED]';
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : sanitizeConfigValue(item, depth + 1);
  }
  return out;
}

/**
 */
function configSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  const snapshot = objectAt(record, 'configSnapshot');
  return sanitizeConfigValue(snapshot) as Record<string, unknown>;
}

function inputPrompt(record: Record<string, unknown>): string {
  const input = objectAt(record, 'input');
  return text(input.prompt || record.prompt);
}

/**
 */
function modelBaseUrl(record: Record<string, unknown>): string | null {
  const config = objectAt(record, 'configSnapshot');
  return nullableText(record.baseUrl || config.baseUrl);
}

/**
 */
export type RunAttribution = {
  schemaVersion: 1;
  prompt: { inputSha256: string | null; inputChars: number; systemPromptVersion: string | null; builder: string | null };
  model: { provider: string | null; model: string | null; mode: string | null; baseUrl: string | null };
  config: Record<string, unknown>;
};

export function buildRunAttribution(record: unknown): RunAttribution {
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
 */
export function withRunAttribution<T extends Record<string, unknown>>(record: T): T & { attribution: RunAttribution } {
  return {
    ...record,
    attribution: buildRunAttribution(record),
  };
}
