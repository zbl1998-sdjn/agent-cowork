import type { CredentialIdentity, CredentialSummary } from './credential-store-types.js';

function scopesFrom(value: Record<string, unknown>): string[] {
  if (Array.isArray(value.scopes)) {
    return value.scopes.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return String(value.scope || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** 从账户对象只摘取可安全展示的字段(login/id/name/email),丢弃其余敏感内容。 */
function safeAccount(account: unknown): Record<string, unknown> | null {
  if (!account || typeof account !== 'object') return null;
  const source = account as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['login', 'id', 'name', 'email']) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return Object.keys(out).length ? out : null;
}

/** 生成「可对外展示的脱敏摘要」:身份、scopes、账户安全字段、更新时间——不含任何密钥。 */
export function summarizeCredential(identity: CredentialIdentity, secret: Record<string, unknown>): CredentialSummary {
  const account = safeAccount(secret.account);
  return {
    provider: String(identity.provider),
    accountId: String(identity.accountId || account?.login || 'default'),
    tenantId: String(identity.tenantId || 'tenant_local'),
    userId: String(identity.userId || 'user_local'),
    scopes: scopesFrom(secret),
    account,
    updatedAt: new Date().toISOString(),
  };
}
