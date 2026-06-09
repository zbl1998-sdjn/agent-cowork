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
 * 判断值是否是可读取字段的普通对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从对象字段安全取子对象;缺失或类型不符时返回空对象。
 */
function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

/**
 * 把可选值转成字符串,null/undefined 统一成空串。
 */
function text(value: unknown): string {
  return value == null ? '' : String(value);
}

/**
 * 取非空字符串;空白输入返回 null,便于归因字段保持稀疏。
 */
function nullableText(value: unknown): string | null {
  const valueText = text(value).trim();
  return valueText ? valueText : null;
}

/**
 * 对原始 prompt 做哈希归因,既能关联同输入,又不落明文。
 */
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 递归清洗配置快照:限深/限数组,敏感键直接抹除,普通文本也走 redaction。
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
 * 从 run 记录里提取并清洗 configSnapshot。
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
 * 从顶层或 configSnapshot 里取模型 baseUrl,只保留非空文本。
 */
function modelBaseUrl(record: Record<string, unknown>): string | null {
  const config = objectAt(record, 'configSnapshot');
  return nullableText(record.baseUrl || config.baseUrl);
}

/**
 * 写入 run 记录的归因结构;只存脱敏配置和 prompt 哈希,不存原始 prompt。
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
 * 在原 run 记录上追加 attribution 字段,保持调用方原字段不变。
 */
export function withRunAttribution<T extends Record<string, unknown>>(record: T): T & { attribution: RunAttribution } {
  return {
    ...record,
    attribution: buildRunAttribution(record),
  };
}
