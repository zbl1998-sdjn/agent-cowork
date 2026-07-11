// Connected-folder authorization resolver (host · L2 runtime).
// This is the single authorization point that combines the canonical path jail
// with an owner-scoped active grant. A grant never expands trustedRootDefault.
import fs from 'node:fs';
import path from 'node:path';

import { assertExternalWorkspaceRoot } from '../security/external-workspace-boundary.js';
import { requireIdentityScopeFrom, type IdentityScope } from '../security/identity-scope.js';
import { assertTrustedPath } from '../security/path-policy.js';
import {
  FOLDER_GRANT_ID_PATTERN,
  type FolderGrantRecord,
  type FolderGrantSource,
} from '../workspace/folder-grant-records.js';
import type { FolderGrantStore } from '../workspace/folder-grant-store.js';

type RequestOwner = { tenantId?: unknown; userId?: unknown } | undefined;
type CreateFolderGrantInput = Readonly<{
  path: string;
  displayName?: string;
  source?: Exclude<FolderGrantSource, 'system'>;
}>;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function ownerFrom(context: RequestOwner): IdentityScope {
  return requireIdentityScopeFrom(context, {
    allowLocalDefault: true,
    label: 'folder grant request identity',
  });
}

function displayName(value: unknown, fallbackPath: string): string {
  const fallback = path.basename(fallbackPath) || 'Workspace';
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw httpError('displayName must be a string', 400);
  const name = value.trim();
  if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw httpError('displayName must contain 1 to 256 visible characters', 400);
  }
  return name;
}

export type FolderGrantRegistry = ReturnType<typeof createFolderGrantRegistry>;

export function createFolderGrantRegistry({
  trustedRootDefault,
  store,
}: Readonly<{ trustedRootDefault: string; store: FolderGrantStore }>) {
  const defaultRoot = assertTrustedPath(
    assertExternalWorkspaceRoot(path.resolve(trustedRootDefault)),
    trustedRootDefault,
  );

  function canonicalRoot(
    value: unknown,
    statusCode: number,
    { preserveNotFound = false }: { preserveNotFound?: boolean } = {},
  ): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw httpError('connected-folder path must be a non-empty string', statusCode);
    }
    try {
      const candidate = assertTrustedPath(
        assertExternalWorkspaceRoot(path.resolve(value)),
        defaultRoot,
      );
      const stats = fs.statSync(candidate);
      if (!stats.isDirectory()) throw new Error('not a directory');
      return candidate;
    } catch (error) {
      if (preserveNotFound && (error as { statusCode?: unknown }).statusCode === 404) throw error;
      throw httpError('connected-folder path is outside the configured trusted root or unavailable', statusCode);
    }
  }

  function ensureSystem(owner: IdentityScope): FolderGrantRecord {
    return store.ensureSystem({
      owner,
      path: defaultRoot,
      displayName: 'Default workspace',
    });
  }

  function activeGrant(owner: IdentityScope, grantId: unknown): FolderGrantRecord {
    if (typeof grantId !== 'string' || !FOLDER_GRANT_ID_PATTERN.test(grantId)) {
      throw httpError('active connected-folder grant is required', 403);
    }
    const grant = store.get(owner, grantId);
    if (!grant || grant.revokedAt !== null) {
      throw httpError('active connected-folder grant is required', 403);
    }
    const grantRoot = canonicalRoot(grant.path, 403);
    if (grant.source === 'system' && !samePath(grantRoot, defaultRoot)) {
      throw httpError('system folder grant is invalid', 403);
    }
    return { ...grant, path: grantRoot };
  }

  return {
    defaultRoot,
    list(context?: RequestOwner, { includeRevoked = false } = {}): FolderGrantRecord[] {
      const owner = ownerFrom(context);
      ensureSystem(owner);
      return store.list(owner, { includeRevoked });
    },
    create(context: RequestOwner, input: CreateFolderGrantInput): FolderGrantRecord {
      const owner = ownerFrom(context);
      const grantRoot = canonicalRoot(input.path, 400);
      if (samePath(grantRoot, defaultRoot)) return ensureSystem(owner);
      return store.create({
        owner,
        path: grantRoot,
        displayName: displayName(input.displayName, grantRoot),
        source: input.source ?? 'manual',
      });
    },
    revoke(context: RequestOwner, grantId: string): FolderGrantRecord | null {
      if (!FOLDER_GRANT_ID_PATTERN.test(grantId)) return null;
      return store.revoke(ownerFrom(context), grantId);
    },
    resolveGrant(context: RequestOwner, grantId: string): FolderGrantRecord {
      return activeGrant(ownerFrom(context), grantId);
    },
    safeTrustedRoot(requestedRoot?: unknown, context?: RequestOwner, grantId?: unknown): string {
      const owner = ownerFrom(context);
      const requested = requestedRoot === undefined || requestedRoot === null || requestedRoot === ''
        ? defaultRoot
        : canonicalRoot(requestedRoot, 400, { preserveNotFound: true });
      if (grantId !== undefined && grantId !== null && grantId !== '') {
        const grant = activeGrant(owner, grantId);
        // Existing routes often substitute trustedRootDefault when their body
        // omits a root. In that compatibility case the selected grant is the
        // authority; an explicit different connected path still fails closed.
        if (samePath(requested, defaultRoot) || samePath(requested, grant.path)) return grant.path;
        throw httpError('connected-folder grant does not authorize the requested root', 403);
      }
      if (samePath(requested, defaultRoot)) {
        ensureSystem(owner);
        return defaultRoot;
      }
      throw httpError('active connected-folder grant is required', 403);
    },
  };
}
