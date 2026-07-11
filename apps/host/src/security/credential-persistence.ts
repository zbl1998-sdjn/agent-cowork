// Persisted credential validation (host · L0): disk data is untrusted.
import { types as utilTypes } from 'node:util';
import {
  canonicalStoredCredentialIdentity,
  credentialIdentityTupleKey,
  legacyCredentialIdentityKey,
} from './credential-identity.js';
import type { CredentialEntry, CredentialSummary } from './credential-store-types.js';
export {
  createCredentialDiskFileOperation,
  credentialEntriesWithoutKey,
  readCredentialDiskFile,
  readCredentialDiskFileForWrite,
  writeCredentialDiskFile,
} from './credential-disk-file.js';
export type { CredentialDiskFile } from './credential-disk-file.js';

const ENTRY_KEYS = ['sealed', 'summary'] as const;
const SUMMARY_KEYS = ['account', 'accountId', 'provider', 'scopes', 'tenantId', 'updatedAt', 'userId'] as const;
const ACCOUNT_KEYS = new Set(['email', 'id', 'login', 'name']);
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SCOPES = 256;
const MAX_SCOPE_LENGTH = 512;
const MAX_ACCOUNT_VALUE_LENGTH = 1024;
const MAX_SEALED_LENGTH = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_CREDENTIAL_PAYLOAD_BYTES = 8 * 1024 * 1024;

type DataRecord = Record<PropertyKey, unknown>;

function dataRecord(value: unknown): DataRecord | null {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value as DataRecord : null;
  } catch {
    return null;
  }
}

function ownDataEntries(record: DataRecord): Array<[string, unknown]> | null {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    return null;
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactValues(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  const record = dataRecord(value);
  if (!record) return null;
  const entries = ownDataEntries(record);
  if (!entries || entries.length !== expectedKeys.length) return null;
  const keys = entries.map(([key]) => key).sort((left, right) => left.localeCompare(right, 'en'));
  if (keys.some((key, index) => key !== expectedKeys[index])) return null;
  return Object.fromEntries(entries) as Record<string, unknown>;
}

function decodeScopes(value: unknown): string[] | null {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value')
    ? lengthDescriptor.value
    : -1;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SCOPES) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) return null;
  const scopes: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    const scope = descriptor.value;
    if (typeof scope !== 'string' || scope.length === 0 || scope.length > MAX_SCOPE_LENGTH) return null;
    scopes.push(scope);
  }
  return scopes;
}

function decodeAccount(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  const record = dataRecord(value);
  if (!record) return undefined;
  const entries = ownDataEntries(record);
  if (!entries) return undefined;
  const account: Record<string, unknown> = {};
  for (const [key, field] of entries) {
    if (!ACCOUNT_KEYS.has(key)) return undefined;
    if (key === 'id') {
      if (typeof field === 'number' && Number.isFinite(field)) account.id = field;
      else if (typeof field === 'string' && field.length <= MAX_ACCOUNT_VALUE_LENGTH) account.id = field;
      else return undefined;
    } else if (typeof field === 'string' && field.length <= MAX_ACCOUNT_VALUE_LENGTH) {
      account[key] = field;
    } else {
      return undefined;
    }
  }
  return account;
}

export function decodeCredentialSummary(value: unknown): CredentialSummary | null {
  const fields = exactValues(value, SUMMARY_KEYS);
  if (!fields) return null;
  const identity = canonicalStoredCredentialIdentity(fields);
  const scopes = decodeScopes(fields.scopes);
  const account = decodeAccount(fields.account);
  const updatedAt = fields.updatedAt;
  if (
    !identity
    || !scopes
    || account === undefined
    || typeof updatedAt !== 'string'
    || updatedAt.length > 64
    || Number.isNaN(Date.parse(updatedAt))
    || new Date(updatedAt).toISOString() !== updatedAt
  ) {
    return null;
  }
  return {
    provider: identity.provider,
    accountId: identity.accountId,
    tenantId: identity.tenantId,
    userId: identity.userId,
    scopes,
    account,
    updatedAt,
  };
}

export function decodeStoredCredentialEntry(key: string, value: unknown): CredentialEntry | null {
  const fields = exactValues(value, ENTRY_KEYS);
  if (!fields || typeof fields.sealed !== 'string' || fields.sealed.length === 0 || fields.sealed.length > MAX_SEALED_LENGTH) {
    return null;
  }
  const summary = decodeCredentialSummary(fields.summary);
  if (
    !summary
    || (credentialIdentityTupleKey(summary) !== key && legacyCredentialIdentityKey(summary) !== key)
  ) return null;
  return { summary, sealed: fields.sealed };
}

export function assertCredentialEntriesWritable(entries: Record<string, unknown>): void {
  const identities = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) {
    const entry = decodeStoredCredentialEntry(key, value);
    if (!entry) throw new Error('credential entry is corrupt or invalid');
    const identityKey = credentialIdentityTupleKey(entry.summary);
    const fingerprint = entry.sealed + '\n' + JSON.stringify(entry.summary);
    const existing = identities.get(identityKey);
    if (existing !== undefined && existing !== fingerprint) {
      throw new Error('credential key conflict between tuple and legacy entries');
    }
    identities.set(identityKey, fingerprint);
  }
}

/** Rebuilds the public DTO; invalid or over-specified summaries are omitted. */
export function credentialSummaryDto(value: unknown): CredentialSummary | null {
  return decodeCredentialSummary(value);
}

function isSafeJsonValue(root: unknown): boolean {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: root }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || ++nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    const value = current.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) return false;
      continue;
    }
    if (typeof value !== 'object' || utilTypes.isProxy(value)) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      let keys: PropertyKey[];
      try {
        keys = Reflect.ownKeys(value);
      } catch {
        return false;
      }
      if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
        stack.push({ depth: current.depth + 1, value: descriptor.value });
      }
      continue;
    }
    const record = dataRecord(value);
    const entries = record ? ownDataEntries(record) : null;
    if (!entries) return false;
    for (const [key, field] of entries) {
      if (DANGEROUS_JSON_KEYS.has(key)) return false;
      stack.push({ depth: current.depth + 1, value: field });
    }
  }
  return true;
}

export function serializeCredentialPayload(value: unknown): string {
  if (!dataRecord(value) || !isSafeJsonValue(value)) {
    throw new Error('credential payload is corrupt or invalid');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('credential payload is corrupt or invalid');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CREDENTIAL_PAYLOAD_BYTES) {
    throw new Error('credential payload is corrupt or invalid');
  }
  parseCredentialPayload(serialized);
  return serialized;
}

export function parseCredentialPayload(plainText: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plainText);
  } catch {
    throw new Error('credential payload is corrupt or invalid');
  }
  if (!dataRecord(parsed) || !isSafeJsonValue(parsed)) {
    throw new Error('credential payload is corrupt or invalid');
  }
  return parsed as Record<string, unknown>;
}
