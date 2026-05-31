// @ts-check
//
// 无状态 JWT 校验(host · L1 领域层 · auth)
// ---------------------------------------------------------------------------
// 职责:零依赖(仅 node:crypto)的 HS256 JWT 验签与声明解析。签名 JWT 让任意 host 实例仅凭 token
//       即可推出 tenant_id/user_id——多租户、可横向扩展的身份路径;声明覆盖请求头默认值。
// 依赖:node:crypto。导出:resolveJwtIdentity(及相关)。
// Stateless JWT (HS256) verification with zero dependencies (node:crypto).
//
// Opaque server-side sessions don't scale across instances; a signed JWT lets
// any host instance derive tenant_id/user_id from the token alone — the
// multi-tenant, horizontally-scalable identity path. Claims are mapped to the
// request context's tenantId/userId, overriding the header defaults.
import crypto from 'node:crypto';

/**
 * @typedef {Record<string, unknown> & {
 *   exp?: number,
 *   nbf?: number,
 *   tenant_id?: unknown,
 *   tid?: unknown,
 *   org?: unknown,
 *   user_id?: unknown,
 *   uid?: unknown,
 *   sub?: unknown,
 * }} JwtPayload
 *
 * @typedef {{ expiresInSec?: number }} SignJwtOptions
 * @typedef {{ now?: number, clockToleranceSec?: number }} VerifyJwtOptions
 *
 * @typedef {object} JwtIdentity
 * @property {string | null} tenantId
 * @property {string | null} userId
 * @property {JwtPayload} claims
 */

/**
 * @param {string} str
 * @returns {Buffer}
 */
function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * @param {Buffer | string} buf
 * @returns {string}
 */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 * 用 HS256 签发 JWT(自动加 iat,可选 exp)。
 * @param {SignJwtOptions} [options]
 * @returns {string}
 */
export function signJwtHS256(payload, secret, { expiresInSec } = {}) {
  if (!secret) throw new Error('signJwtHS256: secret is required');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, ...(expiresInSec ? { exp: now + expiresInSec } : {}), ...payload };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

/**
 * 验签并校验有效期(含时钟容差)的 HS256 JWT;任何不合法/过期返回 null。
 * @param {unknown} token
 * @param {string} secret
 * @param {VerifyJwtOptions} [options]
 * @returns {JwtPayload | null}
 */
export function verifyJwtHS256(token, secret, { now = Math.floor(Date.now() / 1000), clockToleranceSec = 30 } = {}) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  /** @type {{ alg?: unknown } | null} */
  let header;
  /** @type {JwtPayload | null} */
  let payload;
  try {
    header = /** @type {{ alg?: unknown }} */ (JSON.parse(b64urlDecode(h).toString('utf8')));
    payload = /** @type {JwtPayload} */ (JSON.parse(b64urlDecode(p).toString('utf8')));
  } catch { return null; }
  if (!header || header.alg !== 'HS256' || !payload || typeof payload !== 'object') return null;
  const expected = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (typeof payload.exp === 'number' && now > payload.exp + clockToleranceSec) return null;
  if (typeof payload.nbf === 'number' && now + clockToleranceSec < payload.nbf) return null;
  return payload;
}

// Map verified claims to an identity. Accepts common claim names so it works
// with tokens minted by typical IdPs (tenant_id/tid/org, user_id/uid/sub).
/**
 * 验签后把声明映射为身份 { tenantId, userId };兼容常见 IdP 的声明名。失败返回 null。
 * @param {unknown} token
 * @param {string} secret
 * @param {VerifyJwtOptions} [opts]
 * @returns {JwtIdentity | null}
 */
export function resolveJwtIdentity(token, secret, opts) {
  const payload = verifyJwtHS256(token, secret, opts);
  if (!payload) return null;
  const tenant = payload.tenant_id || payload.tid || payload.org || null;
  const user = payload.user_id || payload.uid || payload.sub || null;
  if (!tenant && !user) return null;
  return {
    tenantId: tenant ? String(tenant) : null,
    userId: user ? String(user) : null,
    claims: payload,
  };
}
