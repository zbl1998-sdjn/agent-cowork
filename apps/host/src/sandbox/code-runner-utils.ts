// 代码运行器·纯工具(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:code-runner 用到的无副作用小工具与常量——错误构造、HTTP 错误归一化、
//       按工具/覆盖值挑脚本扩展名、输出预览截断。便于单测,避免塞进主流程。
// 依赖:无。导出:MAX_CODE_BYTES/SCRIPT_DIR_SEGMENTS/fail/toHttpError/pickExt/preview。

export type HttpError = Error & { statusCode?: number; payload?: unknown };

export const MAX_CODE_BYTES = 256 * 1024;
export const SCRIPT_DIR_SEGMENTS = ['.AgentCowork', 'scripts'];

const EXT_RE = /^[a-z0-9]{1,8}$/i;
const EXT_BY_TOOL = Object.freeze({ node: 'js', python: 'py', python3: 'py' });

export function fail(message: string, statusCode = 400): HttpError {
  const error = new Error(`code runner: ${message}`) as HttpError;
  error.statusCode = statusCode;
  return error;
}

export function toHttpError(err: unknown, statusCode?: number): HttpError {
  const error = (err instanceof Error ? err : new Error(String(err || 'unknown error'))) as HttpError;
  if (statusCode && !error.statusCode) {
    error.statusCode = statusCode;
  }
  return error;
}

/** 选脚本扩展名:有 override 校验后用之,否则按工具映射(node->js、python->py),兜底 txt。 */
export function pickExt(tool: string, override: unknown): string {
  if (override != null) {
    const ext = String(override).replace(/^\./, '');
    if (!EXT_RE.test(ext)) {
      throw fail('ext must be a short alphanumeric extension');
    }
    return ext.toLowerCase();
  }
  return (EXT_BY_TOOL as Readonly<Record<string, string>>)[tool] || 'txt';
}

/** 截断文本预览(默认 2000 字,超出加省略号),用于 run 记录里存 stdout/stderr 摘要。 */
export function preview(text: unknown, max = 2000): string {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
