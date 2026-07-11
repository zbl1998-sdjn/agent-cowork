// Encrypted connected-folder grant registry (host · L1 workspace).
// Paths and tombstones are sealed as one snapshot; only schema version and the
// encrypted envelope are visible on disk. Mutations use the existing guarded,
// private atomic single-file abstraction.
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { createDefaultCredentialProtector } from '../security/credential-store.js';
import type { CredentialProtector } from '../security/credential-store-types.js';
import { createManagedSingleFileOperation } from '../security/managed-single-file.js';
import { requireIdentityScopeFrom, type IdentityScope } from '../security/identity-scope.js';
import {
  emptyFolderGrantSnapshot,
  decodeFolderGrantRecord,
  FOLDER_GRANT_ID_PATTERN,
  FOLDER_GRANT_MAX_RECORDS,
  parseFolderGrantSnapshot,
  type FolderGrantRecord,
  type FolderGrantSnapshot,
  type FolderGrantSource,
} from './folder-grant-records.js';

export type FolderGrantStore = ReturnType<typeof createFolderGrantStore>;
export type FolderGrantStoreOptions = Readonly<{
  filePath: string;
  protector?: CredentialProtector;
  idFactory?: () => string;
  now?: () => Date;
}>;

type GrantOwner = IdentityScope | { tenantId?: unknown; userId?: unknown };
type CreateGrantInput = Readonly<{
  owner: GrantOwner;
  path: string;
  displayName: string;
  source: Exclude<FolderGrantSource, 'system'>;
}>;
type EnsureSystemInput = Readonly<{
  owner: GrantOwner;
  path: string;
  displayName: string;
}>;

const MAX_DISK_BYTES = 16 * 1024 * 1024;
const ENVELOPE_KEYS = ['schemaVersion', 'sealed'] as const;

function ownerOf(value: GrantOwner): IdentityScope {
  return requireIdentityScopeFrom(value, { label: 'folder grant owner' });
}

function sameOwner(grant: FolderGrantRecord, owner: IdentityScope): boolean {
  return grant.tenantId === owner.tenantId && grant.userId === owner.userId;
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function parseEnvelope(serialized: string): string {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('folder grant registry is corrupt or invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('folder grant registry is corrupt or invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'));
  if (
    keys.length !== ENVELOPE_KEYS.length
    || keys.some((key, index) => key !== ENVELOPE_KEYS[index])
    || record.schemaVersion !== 1
    || typeof record.sealed !== 'string'
    || record.sealed.length === 0
    || Buffer.byteLength(record.sealed, 'utf8') > MAX_DISK_BYTES
  ) throw new Error('folder grant registry is corrupt or invalid');
  return record.sealed;
}

function safeGrantId(idFactory: () => string): string {
  const id = `grant_${idFactory()}`;
  if (!FOLDER_GRANT_ID_PATTERN.test(id)) throw new Error('folder grant id factory returned an invalid id');
  return id;
}

function cloneGrant(grant: FolderGrantRecord): FolderGrantRecord {
  return Object.freeze({ ...grant });
}

export function createFolderGrantStore({
  filePath,
  protector = createDefaultCredentialProtector(),
  idFactory = randomUUID,
  now = () => new Date(),
}: FolderGrantStoreOptions) {
  if (!filePath) throw new Error('createFolderGrantStore: filePath is required');
  const resolvedFile = path.resolve(filePath);
  let mutationInProgress = false;
  let cachedDiskText: string | null | undefined;
  let cachedSnapshot: FolderGrantSnapshot | null = null;

  function withSynchronousMutation<T>(operation: () => T): T {
    if (mutationInProgress) throw new Error('folder grant registry mutation is already in progress');
    mutationInProgress = true;
    try {
      return operation();
    } finally {
      mutationInProgress = false;
    }
  }

  function read(operation = createManagedSingleFileOperation(resolvedFile, 'Folder grant registry directory')): FolderGrantSnapshot {
    const serialized = operation.readText({ maxBytes: MAX_DISK_BYTES });
    if (serialized === cachedDiskText && cachedSnapshot) {
      return { ...cachedSnapshot, grants: [...cachedSnapshot.grants] };
    }
    if (serialized === null) {
      const empty = emptyFolderGrantSnapshot();
      cachedDiskText = null;
      cachedSnapshot = empty;
      return { ...empty, grants: [] };
    }
    try {
      const decoded = parseFolderGrantSnapshot(protector.unprotect(parseEnvelope(serialized)));
      cachedDiskText = serialized;
      cachedSnapshot = decoded;
      return { ...decoded, grants: [...decoded.grants] };
    } catch {
      throw new Error('folder grant registry is corrupt or invalid');
    }
  }

  function write(snapshot: FolderGrantSnapshot, operation: ReturnType<typeof createManagedSingleFileOperation>): void {
    const plainText = JSON.stringify(snapshot);
    const sealed = protector.protect(plainText);
    if (typeof sealed !== 'string' || sealed.length === 0 || Buffer.byteLength(sealed, 'utf8') > MAX_DISK_BYTES) {
      throw new Error('folder grant registry encryption failed');
    }
    const diskText = JSON.stringify({ schemaVersion: 1, sealed }, null, 2) + '\n';
    operation.writeText(diskText);
    cachedDiskText = diskText;
    cachedSnapshot = { ...snapshot, grants: [...snapshot.grants] };
  }

  function insert(
    input: CreateGrantInput | EnsureSystemInput,
    source: FolderGrantSource,
  ): FolderGrantRecord {
    return withSynchronousMutation(() => {
      const owner = ownerOf(input.owner);
      const canonicalPath = path.resolve(input.path);
      const operation = createManagedSingleFileOperation(resolvedFile, 'Folder grant registry directory');
      const snapshot = read(operation);
      const active = snapshot.grants.find((grant) => (
        sameOwner(grant, owner) && grant.revokedAt === null && samePath(grant.path, canonicalPath)
      ));
      if (active) {
        if ((source === 'system') !== (active.source === 'system')) {
          throw new Error('folder grant registry contains a system grant conflict');
        }
        return cloneGrant(active);
      }
      if (snapshot.grants.length >= FOLDER_GRANT_MAX_RECORDS) {
        const error = new Error('folder grant registry capacity has been reached') as Error & { statusCode?: number };
        error.statusCode = 409;
        throw error;
      }
      const superseded = [...snapshot.grants].reverse().find((grant) => (
        sameOwner(grant, owner) && samePath(grant.path, canonicalPath)
      ));
      const timestamp = now().toISOString();
      const id = safeGrantId(idFactory);
      if (snapshot.grants.some((grant) => grant.id === id)) {
        throw new Error('folder grant id collision');
      }
      const candidate = {
        id,
        tenantId: owner.tenantId,
        userId: owner.userId,
        path: canonicalPath,
        displayName: input.displayName,
        source,
        createdAt: timestamp,
        updatedAt: timestamp,
        revokedAt: null,
        supersedesGrantId: superseded?.id ?? null,
      };
      const grant = decodeFolderGrantRecord(candidate);
      if (!grant) throw new Error('folder grant input is invalid');
      write({ ...snapshot, grants: [...snapshot.grants, grant] }, operation);
      return cloneGrant(grant);
    });
  }

  return {
    filePath: resolvedFile,
    ensureSystem(input: EnsureSystemInput): FolderGrantRecord {
      return insert(input, 'system');
    },
    create(input: CreateGrantInput): FolderGrantRecord {
      return insert(input, input.source);
    },
    list(ownerInput: GrantOwner, { includeRevoked = false } = {}): FolderGrantRecord[] {
      const owner = ownerOf(ownerInput);
      return read().grants
        .filter((grant) => sameOwner(grant, owner) && (includeRevoked || grant.revokedAt === null))
        .map(cloneGrant);
    },
    get(ownerInput: GrantOwner, grantId: string): FolderGrantRecord | null {
      const owner = ownerOf(ownerInput);
      const grant = read().grants.find((candidate) => candidate.id === grantId && sameOwner(candidate, owner));
      return grant ? cloneGrant(grant) : null;
    },
    revoke(ownerInput: GrantOwner, grantId: string): FolderGrantRecord | null {
      return withSynchronousMutation(() => {
        const owner = ownerOf(ownerInput);
        const operation = createManagedSingleFileOperation(resolvedFile, 'Folder grant registry directory');
        const snapshot = read(operation);
        const index = snapshot.grants.findIndex((grant) => grant.id === grantId && sameOwner(grant, owner));
        if (index < 0) return null;
        const current = snapshot.grants[index];
        if (!current) return null;
        if (current.source === 'system') {
          const error = new Error('system folder grant cannot be revoked') as Error & { statusCode?: number };
          error.statusCode = 409;
          throw error;
        }
        if (current.revokedAt !== null) return cloneGrant(current);
        const timestamp = now().toISOString();
        const revoked = decodeFolderGrantRecord({ ...current, updatedAt: timestamp, revokedAt: timestamp });
        if (!revoked) throw new Error('folder grant tombstone is invalid');
        const grants = [...snapshot.grants];
        grants[index] = revoked;
        write({ ...snapshot, grants }, operation);
        return cloneGrant(revoked);
      });
    },
  };
}
