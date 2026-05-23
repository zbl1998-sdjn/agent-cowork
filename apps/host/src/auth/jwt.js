// Stateless JWT (HS256) verification with zero dependencies (node:crypto).
//
// Opaque server-side sessions don't scale across instances; a signed JWT lets
// any host instance derive tenant_id/user_id from the token alone — the
// multi-tenant, horizontally-scalable identity path. Claims are mapped to the
// request context's tenantId/userId, overriding the header defaults.
import crypto from 'node:crypto';

function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signJwtHS256(payload, secret, { expiresInSec } = {}) {
  if (!secret) throw new Error('signJwtHS256: secret is required');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, ...(expiresInSec ? { exp: now + expiresInSec } : {}), ...payload };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

export function verifyJwtHS256(token, secret, { now = Math.floor(Date.now() / 1000), clockToleranceSec = 30 } = {}) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch { return null; }
  if (!header || header.alg !== 'HS256') return null;
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
