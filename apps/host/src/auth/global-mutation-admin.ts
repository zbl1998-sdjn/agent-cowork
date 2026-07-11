// 主机级全局变更授权(host · L1 领域层 · auth)
// ---------------------------------------------------------------------------
// 职责:严格解析可修改 host 全局状态的管理员身份 allowlist,并用权威 requestContext
//       做 tenantId+userId 精确匹配。角色/header/query/body 均不参与授权。
import { types as utilTypes } from 'node:util';
import { sendJson } from '../http/request-utils.js';
import type { HttpResponseLike } from '../http/request-utils.js';
import {
  identityScopeTupleKey,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';

export const GLOBAL_MUTATION_ADMINS_ENV = 'KCW_GLOBAL_MUTATION_ADMINS';

export type GlobalMutationAdminIdentity = Readonly<{
  tenantId: string;
  userId: string;
}>;

type RequestIdentity = { tenantId?: unknown; userId?: unknown };
type RuntimeEnv = Record<string, string | undefined>;

const MAX_ADMIN_IDENTITIES = 128;
const DEFAULT_GLOBAL_MUTATION_ADMINS: readonly GlobalMutationAdminIdentity[] = Object.freeze([
  Object.freeze({ tenantId: 'tenant_local', userId: 'user_local' }),
]);

function invalid(source: string, detail: string): never {
  throw new Error(`${source}: invalid global mutation admin allowlist (${detail})`);
}

function exactIdentity(value: unknown, source: string, index: number): GlobalMutationAdminIdentity {
  let identity: GlobalMutationAdminIdentity;
  try {
    identity = requireIdentityScopeFrom(value, { label: `${source} entry ${index}` });
  } catch {
    return invalid(source, `entry ${index} must contain canonical tenantId and userId data properties`);
  }
  const record = value as Record<PropertyKey, unknown>;
  let keys: PropertyKey[];
  let prototype: object | null;
  try {
    keys = Reflect.ownKeys(record);
    prototype = Object.getPrototypeOf(record);
  } catch {
    return invalid(source, `entry ${index} must be a plain object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(source, `entry ${index} must be a plain object`);
  }
  keys.sort((left, right) => String(left).localeCompare(String(right), 'en'));
  if (keys.length !== 2 || keys[0] !== 'tenantId' || keys[1] !== 'userId') {
    return invalid(source, `entry ${index} must contain exactly tenantId and userId`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return invalid(source, `entry ${index} must contain enumerable data properties`);
    }
  }
  return identity;
}

function parseAllowlist(value: unknown, source: string): readonly GlobalMutationAdminIdentity[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) return invalid(source, 'value must be an array');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) return invalid(source, 'array length is invalid');
  if (length > MAX_ADMIN_IDENTITIES) {
    return invalid(source, `at most ${MAX_ADMIN_IDENTITIES} entries are allowed`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) return invalid(source, 'array must not contain extra properties or holes');
  const identities: GlobalMutationAdminIdentity[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return invalid(source, `entry ${index} must be an enumerable data property`);
    }
    identities.push(exactIdentity(descriptor.value, source, index));
  }
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
      return invalid(source, 'array must contain only canonical index properties');
    }
  }
  const seen = new Set<string>();
  for (const identity of identities) {
    const key = identityScopeTupleKey(identity);
    if (seen.has(key)) return invalid(source, `duplicate identity ${identity.tenantId}/${identity.userId}`);
    seen.add(key);
  }
  return Object.freeze(identities);
}

export function resolveGlobalMutationAdmins(
  configured: unknown,
  env: RuntimeEnv = process.env,
): readonly GlobalMutationAdminIdentity[] {
  if (configured !== undefined) return parseAllowlist(configured, 'HostConfig.globalMutationAdmins');
  const raw = env[GLOBAL_MUTATION_ADMINS_ENV];
  if (raw === undefined) return DEFAULT_GLOBAL_MUTATION_ADMINS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid(GLOBAL_MUTATION_ADMINS_ENV, 'value must be valid JSON');
  }
  return parseAllowlist(parsed, GLOBAL_MUTATION_ADMINS_ENV);
}

export function isGlobalMutationAdmin(
  requestContext: RequestIdentity,
  allowlist: readonly GlobalMutationAdminIdentity[],
): boolean {
  let requestIdentity: GlobalMutationAdminIdentity;
  try {
    requestIdentity = requireIdentityScopeFrom(requestContext, { label: 'global mutation request identity' });
  } catch {
    return false;
  }
  return allowlist.some((adminIdentity) => (
    adminIdentity.tenantId === requestIdentity.tenantId
    && adminIdentity.userId === requestIdentity.userId
  ));
}

/** Returns true when allowed; otherwise emits the uniform 403 and returns false. */
export function requireGlobalMutationAdmin(
  response: HttpResponseLike,
  requestContext: RequestIdentity,
  allowlist: readonly GlobalMutationAdminIdentity[],
): boolean {
  if (isGlobalMutationAdmin(requestContext, allowlist)) return true;
  sendJson(response, 403, { error: 'host-global mutation requires an explicitly allowlisted administrator identity' });
  return false;
}
