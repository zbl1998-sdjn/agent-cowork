// 脱敏(host · L0 基础层,无内部依赖)
// ---------------------------------------------------------------------------
// 职责:在「写日志 / 返回错误体 / 落审计证据」之前,把密钥与敏感文件路径从文本中
//       抹掉。这是纵深防御的「最后一道网」——调用方仍应首先避免打印密钥。
// 依赖:无(纯正则)。导出:redactText(单值) / redactValue(递归对象/数组)。
// 设计要点见下方英文注释(为什么用全局正则、为什么保留 label 只抹 value)。
//
// Secret/PII redaction — a defense-in-depth net that scrubs secrets and
// sensitive filesystem paths out of any text before it is logged, returned in an
// error body, or written to audit/evidence files.
//
// Design intent:
//   * Callers should still avoid logging secrets in the first place. This is the
//     "if one slips through, mask it" backstop.
//   * Patterns are deliberately BROAD and applied GLOBALLY. Over-masking a log
//     line is harmless; leaking a key is not. So every pattern uses the `g` flag
//     and we mask *every* occurrence, not just the first (the previous version
//     used non-global regexes and only masked the first hit — a real gap).
//   * For `label = value` secrets we keep the label (so a log stays debuggable —
//     you can see *that* an api key was present) but replace the value. The old
//     version replaced the *keyword* itself and left the value in clear text.
//
// Order matters: assignments first (so we keep labels), then known token shapes
// and paths as a catch-all for anything not in `label=value` form (e.g. a bare
// `sk-...` or a JWT embedded in a URL).

// 1) `label: value` / `label=value` secrets — mask the VALUE, keep the label.
//    Covers api_key, api_token, access/refresh_token, client_secret, secret,
//    password. The value runs until whitespace/quote/comma/semicolon/paren.
const ASSIGNMENT_RE = /\b((?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)\s*[:=]\s*)"?[^\s"',;)]+/gi;
//    Authorization headers and bare bearer tokens.
const AUTH_HEADER_RE = /\b(authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]+/gi;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._-]{8,}/gi;

// 2) High-signal token shapes, masked wherever they appear (no label needed).
const SENSITIVE_TOKENS = [
  // OpenAI/Moonshot-style API keys: `sk-` followed by a long key body.
  /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{9,}\b/g,
  // JWT: three base64url segments separated by dots.
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Two long dotted opaque segments (covers some session/token formats).
  /\b[A-Za-z0-9]{20,}\.[A-Za-z0-9]{20,}\b/g,
];

// 3) Sensitive filesystem paths: home credential stores, ssh keys, Windows
//    AppData (which can hold tokens/cookies). Masked so logs don't leak layout.
const SENSITIVE_PATHS = [
  /(?:^|[\\/])\.kimi[\\/]credentials(?:[\\/][^\s]*)?/gi,
  /(?:^|[\\/])\.ssh(?:[\\/][^\s]*)?/gi,
  /[\\/]AppData[\\/][^\s\\/]*/gi,
];

/**
 * 抹掉「label=value / label:value」形式的密钥值,以及 Authorization/Bearer 令牌;保留 label 便于排错。
 * @param {string} text
 * @returns {string}
 */
function maskAssignments(text) {
  let t = text.replace(ASSIGNMENT_RE, (_match, label) => `${label}[REDACTED]`);
  t = t.replace(AUTH_HEADER_RE, (_match, label) => `${label}[REDACTED]`);
  t = t.replace(BEARER_RE, 'Bearer [REDACTED]');
  return t;
}

/**
 * 抹掉敏感文件系统路径(凭据库、.ssh、Windows AppData),避免日志泄露目录布局。
 * @param {string} text
 * @returns {string}
 */
function maskPaths(text) {
  return SENSITIVE_PATHS.reduce((acc, re) => acc.replace(re, '[REDACTED_PATH]'), text);
}

/**
 * 兜底:抹掉无 label 的裸令牌形态(sk- 开头的 API Key、JWT、长 opaque 段)。
 * @param {string} text
 * @returns {string}
 */
function maskTokens(text) {
  return SENSITIVE_TOKENS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), text);
}

/**
 * 对单个值脱敏:依次抹赋值式密钥、敏感路径、裸令牌。null/undefined 原样返回,其余转字符串。
 * Redact a single value. Null/undefined pass through; other values are stringified.
 * @param {unknown} value
 * @returns {string | null | undefined}
 */
export function redactText(value) {
  if (value === undefined || value === null) return value;
  let text = String(value);
  text = maskAssignments(text); // keep labels, mask values
  text = maskPaths(text);       // sensitive paths
  text = maskTokens(text);      // catch-all for bare token shapes
  return text;
}

/**
 * 递归脱敏:对对象/数组里的每个字符串都做 redactText,常用于整体脱敏日志载荷。
 * Recursively redact every string inside an object/array.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const source = /** @type {Record<string, unknown>} */ (value);
    const out = /** @type {Record<string, unknown>} */ ({});
    for (const key of Object.keys(source)) out[key] = redactValue(source[key]);
    return out;
  }
  return value;
}
