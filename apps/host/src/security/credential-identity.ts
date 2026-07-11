// Credential identity validation (host · L0 · security).
// Tenant/user reuse the central identity contract. Provider/account remain
// separate raw bounded identifiers because they belong to external systems.
import {
  canonicalIdentityFilter,
  identityScopeTupleKey,
  requireIdentityScopeFrom,
  type IdentityFilter,
  type IdentityScope,
} from './identity-scope.js';
import type { CredentialFilter, CredentialIdentity } from './credential-store-types.js';

const MAX_PROVIDER_LENGTH = 96;
const MAX_ACCOUNT_ID_LENGTH = 256;
const RAW_KEY_PART_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/u;

type OwnValue = { present: false } | { present: true; value: unknown };
export type CanonicalCredentialIdentity = IdentityScope & Readonly<{
  provider: string;
  accountId: string;
}>;
export type CanonicalCredentialFilter = IdentityFilter & Readonly<{
  provider?: string;
  accountId?: string;
}>;

function invalidPart(label: string, maxLength: number): Error {
  return new Error(`${label} must be a raw non-empty string up to ${maxLength} characters`);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownDataValue(value: unknown, key: string, label: string): OwnValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!descriptor) return { present: false };
  if (!Object.hasOwn(descriptor, 'value')) throw new Error(`${label} is invalid`);
  return { present: true, value: descriptor.value };
}

function rawPart(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || !RAW_KEY_PART_PATTERN.test(value)
  ) {
    throw invalidPart(label, maxLength);
  }
  return value;
}

export function canonicalCredentialProvider(value: unknown): string {
  return rawPart(value, 'credential provider', MAX_PROVIDER_LENGTH);
}

export function canonicalCredentialAccountId(value: unknown): string {
  return rawPart(value, 'credential accountId', MAX_ACCOUNT_ID_LENGTH);
}

function credentialIdentity(
  value: unknown,
  { allowMissingAccount }: { allowMissingAccount: boolean },
): CanonicalCredentialIdentity {
  const owner = requireIdentityScopeFrom(value, { label: 'credential identity' });
  const provider = ownDataValue(value, 'provider', 'credential identity');
  const account = ownDataValue(value, 'accountId', 'credential identity');
  if (!provider.present) throw invalidPart('credential provider', MAX_PROVIDER_LENGTH);
  if (!account.present && !allowMissingAccount) {
    throw invalidPart('credential accountId', MAX_ACCOUNT_ID_LENGTH);
  }
  return Object.freeze({
    ...owner,
    provider: canonicalCredentialProvider(provider.value),
    accountId: account.present ? canonicalCredentialAccountId(account.value) : 'default',
  });
}

export function canonicalCredentialIdentity(value: CredentialIdentity): CanonicalCredentialIdentity {
  return credentialIdentity(value, { allowMissingAccount: true });
}

export function canonicalStoredCredentialIdentity(value: unknown): CanonicalCredentialIdentity | null {
  try {
    return credentialIdentity(value, { allowMissingAccount: false });
  } catch (error) {
    void error;
    return null;
  }
}

export function canonicalCredentialFilter(value: CredentialFilter = {}): CanonicalCredentialFilter {
  const ownerFilter = canonicalIdentityFilter(value);
  const provider = ownDataValue(value, 'provider', 'credential filter');
  const account = ownDataValue(value, 'accountId', 'credential filter');
  return Object.freeze({
    ...ownerFilter,
    ...(provider.present ? { provider: canonicalCredentialProvider(provider.value) } : {}),
    ...(account.present ? { accountId: canonicalCredentialAccountId(account.value) } : {}),
  });
}

export function credentialIdentityTupleKey(identity: CanonicalCredentialIdentity): string {
  return identityScopeTupleKey(identity, 'credential', identity.provider, identity.accountId);
}

/** schemaVersion 1 originally joined URL-encoded canonical identity parts with slashes. */
export function legacyCredentialIdentityKey(identity: CanonicalCredentialIdentity): string {
  return [identity.tenantId, identity.userId, identity.provider, identity.accountId]
    .map((part) => encodeURIComponent(part))
    .join('/');
}
