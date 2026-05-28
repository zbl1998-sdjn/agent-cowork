// Pure helper: turn a low-level error (network / fetch / HTTP / JSON parse)
// into a short Chinese sentence a non-technical user can act on.
//
// Goals:
//   1. Never crash on weird inputs (string, Error, unknown).
//   2. Map the common technical "tell" strings to plain-language guidance.
//   3. Fall back to the original message so power users / logs still see truth.
//
// Used by App.tsx, MemoryPanel, ObservabilityPanel, ProjectsPanel, etc.

export type FriendlyErrorOptions = {
  /** Optional verb fragment, e.g. "保存". Shown when no specific mapping fires. */
  action?: string;
};

const HTTP_HINTS: Array<[RegExp, string]> = [
  [/\b400\b/, '请求被服务端拒绝(400),请检查输入是否合法'],
  [/\b401\b/, '没有权限或登录已过期(401),请重新登录或填写 API Key'],
  [/\b403\b/, '当前账号没有该操作的权限(403)'],
  [/\b404\b/, '找不到对应的资源(404),可能是路径或 ID 已失效'],
  [/\b408\b|timeout|timed?\s*out|ETIMEDOUT/i, '请求超时,网络较慢或后端无响应,请稍后重试'],
  [/\b409\b/, '操作发生冲突(409),请刷新后再试'],
  [/\b413\b/, '上传/请求内容过大(413),请减小后重试'],
  [/\b429\b|rate.?limit/i, '请求过于频繁(429),请稍等几秒再试'],
  [/\b5\d\d\b|Internal Server Error/i, '后端服务暂时出错(5xx),请稍后重试或查看后台日志'],
];

const NETWORK_HINTS: Array<[RegExp, string]> = [
  [/ECONNREFUSED|connection refused/i, '无法连接本地服务(host),请确认 Agent Cowork 后台是否已启动'],
  [/ECONNRESET|socket hang up/i, '连接被中断,请重试一次'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, '域名解析失败,请检查网络或代理设置'],
  [/Failed to fetch|NetworkError|net::ERR_/i, '网络请求失败,请检查网络连接'],
  [/AbortError|aborted/i, '请求已被取消'],
];

const PARSE_HINTS: Array<[RegExp, string]> = [
  [/Unexpected token .* in JSON|is not valid JSON|JSON\.parse|SyntaxError.*JSON/i, '后端返回的不是合法 JSON,可能是接口走错(命中了网页而不是 API)'],
  [/SyntaxError/i, '解析返回内容时出错'],
];

function rawMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Turn an unknown error into a single Chinese sentence end-users can read.
 * Always returns a non-empty string.
 *
 * The original technical message is appended in parentheses ONLY when a
 * mapping fired AND it differs meaningfully — so power users can still see
 * what the raw error said without having to open devtools.
 */
export function humanizeError(err: unknown, options: FriendlyErrorOptions = {}): string {
  const raw = rawMessage(err).trim();
  if (!raw) return options.action ? `${options.action}失败,但没有错误信息` : '操作失败,但没有错误信息';

  for (const [pattern, hint] of NETWORK_HINTS) if (pattern.test(raw)) return hint;
  for (const [pattern, hint] of HTTP_HINTS) if (pattern.test(raw)) return hint;
  for (const [pattern, hint] of PARSE_HINTS) if (pattern.test(raw)) return hint;

  // No mapping — surface the raw message but prefix with the action verb if
  // the caller supplied one. Cap length so a giant stack trace doesn't blow
  // up the UI.
  const truncated = raw.length > 200 ? `${raw.slice(0, 198)}…` : raw;
  return options.action ? `${options.action}失败:${truncated}` : truncated;
}
