// Canonical tenant/user identity primitives (host · L0 · security).
// Values are validated without coercion or trimming so distinct principals
// cannot collapse onto the same storage, authorization, or cache key.
import { types as utilTypes } from 'node:util';

const IDENTITY_PART_PATTERN = /^[A-Za-z0-9_.:-]{1,96}$/;
const IDENTITY_TUPLE_VERSION = 'identity-scope:v1';

export type IdentityScope = Readonly<{ tenantId: string; userId: string }>;
export type IdentityFilter = Readonly<{ tenantId?: string; userId?: string }>;

export const LOCAL_IDENTITY_SCOPE: IdentityScope = Object.freeze({
  tenantId: 'tenant_local',
  userId: 'user_local',
});

type ScopeSource = { tenantId?: unknown; userId?: unknown };
type RequireScopeOptions = { allowLocalDefault?: boolean; label?: string };
type OwnValue = { present: false } | { present: true; value: unknown };

function invalidIdentity(label: string): Error {
  return new Error(`${label}: canonical tenantId and userId are required`);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null
    && typeof value === 'object'
    && !utilTypes.isProxy(value)
    && !Array.isArray(value);
}

function ownDataValue(source: Record<PropertyKey, unknown>, key: string, label: string): OwnValue {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    throw invalidIdentity(label);
  }
  if (!descriptor) return { present: false };
  if (!Object.hasOwn(descriptor, 'value')) throw invalidIdentity(label);
  return { present: true, value: descriptor.value };
}

export function canonicalIdentityPart(value: unknown): string | null {
  return typeof value === 'string' && IDENTITY_PART_PATTERN.test(value) ? value : null;
}

export function canonicalRequiredIdentityScope(
  tenantId: unknown,
  userId: unknown,
): IdentityScope | null {
  const canonicalTenantId = canonicalIdentityPart(tenantId);
  const canonicalUserId = canonicalIdentityPart(userId);
  return canonicalTenantId && canonicalUserId
    ? Object.freeze({ tenantId: canonicalTenantId, userId: canonicalUserId })
    : null;
}

export function requireCanonicalIdentityScope(
  tenantId: unknown,
  userId: unknown,
  label = 'identity',
): IdentityScope {
  const scope = canonicalRequiredIdentityScope(tenantId, userId);
  if (!scope) throw invalidIdentity(label);
  return scope;
}

export function requireIdentityScopeFrom(
  value: unknown,
  { allowLocalDefault = false, label = 'identity' }: RequireScopeOptions = {},
): IdentityScope {
  if (value === undefined && allowLocalDefault) return LOCAL_IDENTITY_SCOPE;
  if (!isRecord(value)) throw invalidIdentity(label);
  const tenant = ownDataValue(value, 'tenantId', label);
  const user = ownDataValue(value, 'userId', label);
  if (!tenant.present || !user.present) throw invalidIdentity(label);
  return requireCanonicalIdentityScope(tenant.value, user.value, label);
}

export function canonicalIdentityFilter(value: unknown = {}): IdentityFilter {
  const label = 'identity filter';
  if (!isRecord(value)) throw invalidIdentity(label);
  const tenant = ownDataValue(value, 'tenantId', label);
  const user = ownDataValue(value, 'userId', label);
  const filter: { tenantId?: string; userId?: string } = {};
  if (tenant.present) {
    const tenantId = canonicalIdentityPart(tenant.value);
    if (!tenantId) throw invalidIdentity(label);
    filter.tenantId = tenantId;
  }
  if (user.present) {
    const userId = canonicalIdentityPart(user.value);
    if (!userId) throw invalidIdentity(label);
    filter.userId = userId;
  }
  return Object.freeze(filter);
}

export function identityScopeTupleKey(scope: ScopeSource, ...parts: string[]): string {
  const canonical = requireIdentityScopeFrom(scope, { label: 'identity tuple scope' });
  if (parts.some((part) => typeof part !== 'string')) {
    throw new Error('identity tuple parts must be strings');
  }
  return JSON.stringify([
    IDENTITY_TUPLE_VERSION,
    canonical.tenantId,
    canonical.userId,
    ...parts,
  ]);
}
