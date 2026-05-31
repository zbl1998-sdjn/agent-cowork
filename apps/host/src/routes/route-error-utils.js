// @ts-check
// 路由错误归一化:把 unknown error 稳定转为 status/message/payload。

/** @typedef {Error & { statusCode?: number, payload?: Record<string, unknown> }} RouteError */

/** @param {unknown} err @param {number} fallback @returns {number} */
export function errorStatus(err, fallback) {
  const error = /** @type {Partial<RouteError>} */ (err);
  return Number(error?.statusCode) || fallback;
}

/** @param {unknown} err @returns {string} */
export function errorMessage(err) {
  return /** @type {Partial<RouteError>} */ (err)?.message || String(err || 'request failed');
}

/** @param {unknown} err @returns {Record<string, unknown>} */
export function errorPayload(err) {
  const error = /** @type {Partial<RouteError>} */ (err);
  return error?.payload && typeof error.payload === 'object' ? error.payload : {};
}
