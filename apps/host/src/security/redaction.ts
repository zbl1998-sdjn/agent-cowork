// 脱敏(host · L0 基础层,无内部依赖)
import { types as utilTypes } from 'node:util';

// ---------------------------------------------------------------------------
// 职责:在「写日志 / 返回错误体 / 落审计证据」之前,把密钥与敏感文件路径从文本中
//       抹掉。这是纵深防御的「最后一道网」——调用方仍应首先避免打印密钥。
// 依赖:node:util(仅 Proxy 判定)。导出:redactText(单值) / redactValue(递归对象/数组)。
// 设计要点:
//   * 调用方仍应首先避免打印密钥;这里是「万一漏出也要兜住」的后备网。
//   * 规则有意偏宽且全部全局应用。日志被多抹一点是可接受的,密钥漏出不可接受;
//     因此所有模式都带 `g`,每个命中都会被替换,不能只处理第一处。
//   * `label = value` 形式保留 label、只抹 value:日志仍能看出「这里出现过 api key」,
//     但不会把真实值写出去。
//   * 顺序很重要:先处理赋值形式以保留 label,再处理裸 token 与路径兜底。
//
// 1) `label: value` / `label=value` 密钥:保留 label、替换 value。
//    覆盖 api_key/api_token/access_token/refresh_token/client_secret/secret/password 等;
//    value 截止到空白、引号、逗号、分号或右括号。
const ASSIGNMENT_RE = /\b((?:(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|credential|token|cookie|set[_-]?cookie|private[_-]?key)\s*[:=]\s*|authorization\s*[:=]\s*(?:bearer\s+)?))"?[^\s"',;)]+/gi;
//    Authorization 头与裸 bearer token 也按同一原则只保留结构、不保留密钥。
const AUTH_HEADER_RE = /\b(authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]+/gi;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._-]{8,}/gi;

// 2) 高置信 token 形状:即使没有 label,出现在任意位置也直接抹掉。
const SENSITIVE_TOKENS: readonly RegExp[] = [
  // OpenAI/Moonshot 风格 API key:`sk-` 加较长 key body。
  /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{9,}\b/g,
  // JWT:三个 base64url 段用点分隔。
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // 两段长 opaque token,覆盖部分 session/token 格式。
  /\b[A-Za-z0-9]{20,}\.[A-Za-z0-9]{20,}\b/g,
];

// 3) 敏感文件系统路径:凭据目录、SSH key、Windows AppData(可能含 token/cookie)。
//    抹路径是为了日志不泄漏本机目录结构和凭据位置。
const SENSITIVE_PATHS: readonly RegExp[] = [
  /(?:^|[\\/])\.kimi[\\/]credentials(?:[\\/][^\s]*)?/gi,
  /(?:^|[\\/])\.ssh(?:[\\/][^\s]*)?/gi,
  /[\\/]AppData[\\/][^\s\\/]*/gi,
];

function maskAssignments(text: string): string {
  let t = text.replace(ASSIGNMENT_RE, (_match, label) => `${label}[REDACTED]`);
  t = t.replace(AUTH_HEADER_RE, (_match, label) => `${label}[REDACTED]`);
  t = t.replace(BEARER_RE, 'Bearer [REDACTED]');
  return t;
}

function maskPaths(text: string): string {
  return SENSITIVE_PATHS.reduce((acc, re) => acc.replace(re, '[REDACTED_PATH]'), text);
}

function maskTokens(text: string): string {
  return SENSITIVE_TOKENS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), text);
}

export function redactText(value: null): null;
export function redactText(value: undefined): undefined;
export function redactText(value: unknown): string | null | undefined;
export function redactText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  let text = String(value);
  text = maskAssignments(text);
  text = maskPaths(text);
  text = maskTokens(text);
  return text;
}

type RedactableRecord = Record<string, unknown>;

export const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_FIELD_KEYS = new Set([
  'apikey',
  'apitoken',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'secret',
  'password',
  'passwd',
  'authorization',
  'credential',
  'token',
  'cookie',
  'setcookie',
  'privatekey',
]);

export function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_FIELD_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function redactValue(value: unknown): unknown {
  if (utilTypes.isProxy(value)) throw new Error('cannot redact proxy values');
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const source = value as RedactableRecord;
    const out: RedactableRecord = {};
    for (const key of Object.keys(source)) {
      out[key] = isSensitiveFieldName(key) ? REDACTED_VALUE : redactValue(source[key]);
    }
    return out;
  }
  return value;
}
