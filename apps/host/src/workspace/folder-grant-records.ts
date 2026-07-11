// Connected-folder grant persistence contract (host · L1 workspace).
// The encrypted payload is still untrusted after decryption, so every field is
// decoded exactly before it can participate in an authorization decision.
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import { canonicalRequiredIdentityScope } from '../security/identity-scope.js';

export const FOLDER_GRANT_ID_PATTERN = /^grant_[A-Za-z0-9-]{1,72}$/;
export const FOLDER_GRANT_SCHEMA_VERSION = 1 as const;

export type FolderGrantSource = 'system' | 'picker' | 'manual';
export type FolderGrantRecord = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  path: string;
  displayName: string;
  source: FolderGrantSource;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  supersedesGrantId: string | null;
}>;
export type FolderGrantSnapshot = {
  schemaVersion: typeof FOLDER_GRANT_SCHEMA_VERSION;
  grants: FolderGrantRecord[];
};

const RECORD_KEYS = [
  'createdAt',
  'displayName',
  'id',
  'path',
  'revokedAt',
  'source',
  'supersedesGrantId',
  'tenantId',
  'updatedAt',
  'userId',
] as const;
const SNAPSHOT_KEYS = ['grants', 'schemaVersion'] as const;
export const FOLDER_GRANT_MAX_RECORDS = 10_000;
const MAX_PATH_LENGTH = 32_768;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = plainRecord(value);
  if (!record) return null;
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
    ? record
    : null;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString() === value ? value : null;
}

function canonicalPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function decodeFolderGrantRecord(value: unknown): FolderGrantRecord | null {
  const fields = exactRecord(value, RECORD_KEYS);
  if (!fields) return null;
  const identity = canonicalRequiredIdentityScope(fields.tenantId, fields.userId);
  const createdAt = canonicalIso(fields.createdAt);
  const updatedAt = canonicalIso(fields.updatedAt);
  const revokedAt = fields.revokedAt === null ? null : canonicalIso(fields.revokedAt);
  const supersedesGrantId = fields.supersedesGrantId === null
    ? null
    : typeof fields.supersedesGrantId === 'string' && FOLDER_GRANT_ID_PATTERN.test(fields.supersedesGrantId)
      ? fields.supersedesGrantId
      : null;
  const source = fields.source;
  if (
    !identity
    || typeof fields.id !== 'string'
    || !FOLDER_GRANT_ID_PATTERN.test(fields.id)
    || typeof fields.path !== 'string'
    || !path.isAbsolute(fields.path)
    || fields.path.length === 0
    || fields.path.length > MAX_PATH_LENGTH
    || typeof fields.displayName !== 'string'
    || fields.displayName.length === 0
    || fields.displayName.length > 256
    || (source !== 'system' && source !== 'picker' && source !== 'manual')
    || !createdAt
    || !updatedAt
    || (fields.revokedAt !== null && !revokedAt)
    || (fields.supersedesGrantId !== null && !supersedesGrantId)
    || supersedesGrantId === fields.id
  ) return null;
  return Object.freeze({
    id: fields.id,
    tenantId: identity.tenantId,
    userId: identity.userId,
    path: path.resolve(fields.path),
    displayName: fields.displayName,
    source,
    createdAt,
    updatedAt,
    revokedAt,
    supersedesGrantId,
  });
}

export function decodeFolderGrantSnapshot(value: unknown): FolderGrantSnapshot | null {
  const root = exactRecord(value, SNAPSHOT_KEYS);
  if (!root || root.schemaVersion !== FOLDER_GRANT_SCHEMA_VERSION || !Array.isArray(root.grants)) return null;
  if (utilTypes.isProxy(root.grants) || root.grants.length > FOLDER_GRANT_MAX_RECORDS) return null;
  const grants: FolderGrantRecord[] = [];
  const ids = new Set<string>();
  const activeRoots = new Set<string>();
  for (const value of root.grants) {
    const grant = decodeFolderGrantRecord(value);
    if (!grant || ids.has(grant.id)) return null;
    ids.add(grant.id);
    if (grant.revokedAt === null) {
      const activeKey = JSON.stringify([
        grant.tenantId,
        grant.userId,
        canonicalPathKey(grant.path),
      ]);
      if (activeRoots.has(activeKey)) return null;
      activeRoots.add(activeKey);
    }
    grants.push(grant);
  }
  return { schemaVersion: FOLDER_GRANT_SCHEMA_VERSION, grants };
}

export function parseFolderGrantSnapshot(serialized: string): FolderGrantSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('folder grant registry is corrupt or invalid');
  }
  const snapshot = decodeFolderGrantSnapshot(parsed);
  if (!snapshot) throw new Error('folder grant registry is corrupt or invalid');
  return snapshot;
}

export function emptyFolderGrantSnapshot(): FolderGrantSnapshot {
  return { schemaVersion: FOLDER_GRANT_SCHEMA_VERSION, grants: [] };
}
