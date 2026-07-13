// ONLYOFFICE 无状态会话(host · L1 artifacts)
// ---------------------------------------------------------------------------
// 职责:把审批后的路径、owner scope、版本与期限封装进签名 token，使 host 重启后回调仍可验证。
import crypto from 'node:crypto';

import { signOnlyOfficeJwt, verifyOnlyOfficeJwt } from './onlyoffice-jwt.js';

const PURPOSE = 'agent-cowork:onlyoffice-session';

export type OnlyOfficeSessionClaims = Readonly<{
  purpose: typeof PURPOSE;
  version: 1;
  jti: string;
  iat: number;
  exp: number;
  documentKey: string;
  trustedRoot: string;
  sourcePath: string;
  targetPath: string;
  copyName: string;
  sourceRevisionSha256: string;
  tenantId: string;
  userId: string;
}>;

export function createOnlyOfficeSessionToken(input: Omit<OnlyOfficeSessionClaims, 'purpose' | 'version' | 'jti' | 'iat' | 'exp' | 'documentKey'> & {
  ttlMs: number;
  secret: string;
  nowMs?: number;
  randomId?: () => string;
}): { token: string; claims: OnlyOfficeSessionClaims } {
  const nowMs = input.nowMs ?? Date.now();
  const jti = (input.randomId ?? crypto.randomUUID)().replace(/[^A-Za-z0-9-]/gu, '');
  const documentKey = crypto.createHash('sha256')
    .update(`${input.sourceRevisionSha256}:${jti}`)
    .digest('hex')
    .slice(0, 48);
  const claims: OnlyOfficeSessionClaims = Object.freeze({
    purpose: PURPOSE,
    version: 1,
    jti,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + input.ttlMs) / 1000),
    documentKey,
    trustedRoot: input.trustedRoot,
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    copyName: input.copyName,
    sourceRevisionSha256: input.sourceRevisionSha256,
    tenantId: input.tenantId,
    userId: input.userId,
  });
  return { token: signOnlyOfficeJwt(claims, input.secret), claims };
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new Error(`ONLYOFFICE session ${key} is invalid`);
  return value;
}

export function verifyOnlyOfficeSessionToken(token: unknown, secret: string): OnlyOfficeSessionClaims {
  const payload = verifyOnlyOfficeJwt(token, secret);
  if (payload.purpose !== PURPOSE || payload.version !== 1) throw new Error('ONLYOFFICE session purpose is invalid');
  return Object.freeze({
    purpose: PURPOSE,
    version: 1,
    jti: requiredString(payload, 'jti'),
    iat: Number(payload.iat),
    exp: Number(payload.exp),
    documentKey: requiredString(payload, 'documentKey'),
    trustedRoot: requiredString(payload, 'trustedRoot'),
    sourcePath: requiredString(payload, 'sourcePath'),
    targetPath: requiredString(payload, 'targetPath'),
    copyName: requiredString(payload, 'copyName'),
    sourceRevisionSha256: requiredString(payload, 'sourceRevisionSha256'),
    tenantId: requiredString(payload, 'tenantId'),
    userId: requiredString(payload, 'userId'),
  });
}
