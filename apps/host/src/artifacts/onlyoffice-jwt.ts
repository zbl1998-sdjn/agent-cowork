// ONLYOFFICE JWT(host · L1 artifacts)
// ---------------------------------------------------------------------------
// 职责:用 Node crypto 实现固定 HS256 的最小 JWT 签发/校验，避免引入浮动依赖。
import crypto from 'node:crypto';

export type OnlyOfficeJwtPayload = Readonly<Record<string, unknown>>;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`ONLYOFFICE JWT ${label} is invalid`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ONLYOFFICE JWT ${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function signature(input: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(input).digest();
}

export function signOnlyOfficeJwt(payload: OnlyOfficeJwtPayload, secret: string): string {
  if (!secret) throw new Error('ONLYOFFICE JWT secret is required');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${signature(unsigned, secret).toString('base64url')}`;
}

export function verifyOnlyOfficeJwt(
  token: unknown,
  secret: string,
  { nowSeconds = Math.floor(Date.now() / 1000) }: { nowSeconds?: number } = {},
): Record<string, unknown> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128 * 1024) {
    throw new Error('ONLYOFFICE JWT is missing or invalid');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('ONLYOFFICE JWT must contain three parts');
  const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts;
  const header = decodeObject(encodedHeader, 'header');
  if (header.alg !== 'HS256') throw new Error('ONLYOFFICE JWT must use HS256');
  const actual = Buffer.from(encodedSignature, 'base64url');
  const expected = signature(`${encodedHeader}.${encodedPayload}`, secret);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('ONLYOFFICE JWT signature is invalid');
  }
  const payload = decodeObject(encodedPayload, 'payload');
  if (typeof payload.exp === 'number' && payload.exp < nowSeconds) {
    throw new Error('ONLYOFFICE JWT has expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) {
    throw new Error('ONLYOFFICE JWT is not active yet');
  }
  return payload;
}

export function onlyOfficeBearerToken(value: unknown): string {
  const match = String(value || '').trim().match(/^Bearer\s+(.+)$/iu);
  if (!match?.[1]) throw Object.assign(new Error('ONLYOFFICE callback JWT is required'), { statusCode: 403 });
  return match[1];
}
