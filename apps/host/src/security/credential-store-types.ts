// 凭据存储契约类型(host · L0 基础层 · security)
// ---------------------------------------------------------------------------
// 职责:集中定义凭据库的身份/摘要/存储项/加解密保护器等类型契约,供 credential-store
//       与 credential-summary 复用,保证脱敏摘要与落盘结构的形状一致。

export type CredentialIdentity = {
  tenantId?: unknown;
  userId?: unknown;
  provider?: unknown;
  accountId?: unknown;
};
export type CredentialSummary = {
  provider: string;
  accountId: string;
  tenantId: string;
  userId: string;
  scopes: string[];
  account: Record<string, unknown> | null;
  updatedAt: string;
};
export type CredentialEntry = { summary: CredentialSummary; sealed: string };
export type CredentialFile = { schemaVersion: number; entries: Record<string, CredentialEntry> };
export type CredentialProtector = {
  protect(plainText: unknown): string;
  unprotect(sealedText: unknown): string;
};
export type CredentialStoreOptions = { filePath?: string; protector?: CredentialProtector };
export type CredentialFilter = {
  tenantId?: unknown;
  userId?: unknown;
  provider?: unknown;
  accountId?: unknown;
};
export type CredentialStore = {
  put(identity: CredentialIdentity, secret: Record<string, unknown>): CredentialSummary;
  get(identity: CredentialIdentity): Record<string, unknown> | null;
  list(filter?: CredentialFilter): CredentialSummary[];
  delete(identity: CredentialIdentity): boolean;
  deleteMany(filter?: CredentialFilter): number;
};
