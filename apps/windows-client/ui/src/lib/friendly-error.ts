// 友好错误(UI · 逻辑层 · lib)
// ---------------------------------------------------------------------------
// 职责:把底层错误(网络/fetch/HTTP/JSON 解析)翻译成非技术用户可读、可行动的简短中文,
// 对未命中映射的原始信息做截断兜底,任何输入都不崩溃。呼应 host「错误可读/永不空交代」原则。
// 被 App.tsx、各面板(Memory/Observability/Projects 等)使用。导出:humanizeError、FriendlyErrorOptions。
export type FriendlyErrorOptions = {
  /** 可选动作动词,如"保存";未命中特定映射时用于补齐"保存失败"这类语境。 */
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
 * 把未知错误压成终端用户可读的一句中文,并保证始终返回非空字符串。
 *
 * 只有在命中映射且原始技术信息确有差异时才附带原文,让高级用户不用开 devtools
 * 也能看到底层错误。
 */
export function humanizeError(err: unknown, options: FriendlyErrorOptions = {}): string {
  const raw = rawMessage(err).trim();
  if (!raw) return options.action ? `${options.action}失败,但没有错误信息` : '操作失败,但没有错误信息';

  for (const [pattern, hint] of NETWORK_HINTS) if (pattern.test(raw)) return hint;
  for (const [pattern, hint] of HTTP_HINTS) if (pattern.test(raw)) return hint;
  for (const [pattern, hint] of PARSE_HINTS) if (pattern.test(raw)) return hint;

  // 未命中映射时展示原始信息;若调用方给了动作动词就加在前面。长度上限防止巨大堆栈撑爆 UI。
  const truncated = raw.length > 200 ? `${raw.slice(0, 198)}…` : raw;
  return options.action ? `${options.action}失败:${truncated}` : truncated;
}
