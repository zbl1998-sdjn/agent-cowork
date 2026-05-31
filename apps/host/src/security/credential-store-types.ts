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
