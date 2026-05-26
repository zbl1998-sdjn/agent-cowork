/**
 * @typedef {Error & { statusCode?: number, payload?: unknown }} HttpError
 */

export const MAX_CODE_BYTES = 256 * 1024;
export const SCRIPT_DIR_SEGMENTS = ['.AgentCowork', 'scripts'];

const EXT_RE = /^[a-z0-9]{1,8}$/i;
/** @type {Readonly<Record<string, string>>} */
const EXT_BY_TOOL = Object.freeze({ node: 'js', python: 'py', python3: 'py' });

/** @param {string} message @param {number} [statusCode] @returns {HttpError} */
export function fail(message, statusCode = 400) {
  const error = /** @type {HttpError} */ (new Error(`code runner: ${message}`));
  error.statusCode = statusCode;
  return error;
}

/** @param {unknown} err @param {number} [statusCode] @returns {HttpError} */
export function toHttpError(err, statusCode) {
  const error = /** @type {HttpError} */ (
    err instanceof Error ? err : new Error(String(err || 'unknown error'))
  );
  if (statusCode && !error.statusCode) {
    error.statusCode = statusCode;
  }
  return error;
}

/** @param {string} tool @param {unknown} override @returns {string} */
export function pickExt(tool, override) {
  if (override != null) {
    const ext = String(override).replace(/^\./, '');
    if (!EXT_RE.test(ext)) {
      throw fail('ext must be a short alphanumeric extension');
    }
    return ext.toLowerCase();
  }
  return EXT_BY_TOOL[tool] || 'txt';
}

/** @param {unknown} text @param {number} [max] @returns {string} */
export function preview(text, max = 2000) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
