// 凭据脱敏摘要生成器(host · L0 基础层 · security)
// ---------------------------------------------------------------------------
// 职责:把原始凭据(含密钥的 secret)归一为「可对外展示的摘要」——只保留身份、
//       scopes、账户安全字段(login/id/name/email)与更新时间,剔除一切敏感内容。
// 依赖:L0 security/credential-store-types(仅类型)。导出:summarizeCredential。
// 实现:safeAccount 白名单摘取账户字段;scopesFrom 兼容数组 scopes 与空格分隔的 scope 串。
import { types as utilTypes } from 'node:util';
import { canonicalCredentialIdentity } from './credential-identity.js';
import type { CredentialIdentity, CredentialSummary } from './credential-store-types.js';

const ACCOUNT_KEYS = ['login', 'id', 'name', 'email'] as const;
const MAX_ACCOUNT_VALUE_LENGTH = 1024;
const MAX_SCOPE_LENGTH = 512;

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function scopesFrom(value: Record<string, unknown>): string[] {
  const scopes = ownDataValue(value, 'scopes');
  if (!utilTypes.isProxy(scopes) && Array.isArray(scopes)) {
    const result: string[] = [];
    for (let index = 0; index < scopes.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(scopes, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
      const scope = typeof descriptor.value === 'string' ? descriptor.value.trim() : '';
      if (scope && scope.length <= MAX_SCOPE_LENGTH) result.push(scope);
    }
    return result;
  }
  const scope = ownDataValue(value, 'scope');
  return typeof scope === 'string'
    ? scope.split(/\s+/).map((part) => part.trim()).filter((part) => part.length <= MAX_SCOPE_LENGTH && part.length > 0)
    : [];
}

/** 从账户对象只摘取可安全展示的字段(login/id/name/email),丢弃其余敏感内容。 */
function safeAccount(account: unknown): Record<string, unknown> | null {
  if (!account || typeof account !== 'object' || utilTypes.isProxy(account) || Array.isArray(account)) return null;
  const prototype = Object.getPrototypeOf(account);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const source = account as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ACCOUNT_KEYS) {
    const field = ownDataValue(source, key);
    if (key === 'id') {
      if (typeof field === 'string' && field.length <= MAX_ACCOUNT_VALUE_LENGTH) out.id = field;
      else if (typeof field === 'number' && Number.isSafeInteger(field)) out.id = field;
    } else if (typeof field === 'string' && field.length <= MAX_ACCOUNT_VALUE_LENGTH) {
      out[key] = field;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** 生成「可对外展示的脱敏摘要」:身份、scopes、账户安全字段、更新时间——不含任何密钥。 */
export function summarizeCredential(identity: CredentialIdentity, secret: Record<string, unknown>): CredentialSummary {
  const canonical = canonicalCredentialIdentity(identity);
  const account = safeAccount(ownDataValue(secret, 'account'));
  return {
    provider: canonical.provider,
    accountId: canonical.accountId,
    tenantId: canonical.tenantId,
    userId: canonical.userId,
    scopes: scopesFrom(secret),
    account,
    updatedAt: new Date().toISOString(),
  };
}
