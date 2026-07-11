// Live artifact filesystem transaction (host · L1 artifacts).
// Pins the artifact directory and only rolls back files whose captured identity still matches.
import fs from 'node:fs';

import {
  createManagedDirectoryBoundary,
} from '../security/managed-directory-boundary.js';
import { writePrivateFileOnceAtomically } from '../security/private-atomic-file.js';
import {
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
  removeCreatedArtifactOwnerClaim,
} from './artifact-owner.js';
import { fail } from './live-spec.js';
import type {
  ManagedDirectoryBoundary,
  ManagedPathInspection,
} from '../security/managed-directory-boundary.js';
import type { ArtifactOwnerClaimResult } from './artifact-owner.js';

type PublishedFile = {
  filePath: string;
  identity: ManagedPathInspection | null;
};

export type LiveArtifactTransaction = Readonly<{
  publish(filePath: string, data: string): boolean;
  rollback(primary: unknown): never;
}>;

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === code;
}

function throwWithRollbackFailures(primary: unknown, rollbackErrors: unknown[]): never {
  if (rollbackErrors.length === 0) throw primary;
  throw new AggregateError(
    [primary, ...rollbackErrors],
    'artifact publication failed and rollback was incomplete',
    { cause: primary },
  );
}

function reserveOwnerClaims({
  boundary,
  guard,
  trustedRoot,
  htmlPath,
  manifestPath,
  owner,
}: {
  boundary: ManagedDirectoryBoundary;
  guard: (candidatePath: string) => void;
  trustedRoot: string;
  htmlPath: string;
  manifestPath: string;
  owner: unknown;
}): ArtifactOwnerClaimResult[] {
  for (const artifactPath of [htmlPath, manifestPath]) {
    if (!boundary.inspectPath(artifactPath, { allowMissing: true, kind: 'file' })) continue;
    authorizeArtifactOwner({
      trustedRoot,
      artifactPath,
      context: owner,
      beforeFilesystemMutation: guard,
    });
    throw fail('artifact already exists', 409);
  }
  const claims: ArtifactOwnerClaimResult[] = [];
  try {
    for (const artifactPath of [htmlPath, manifestPath]) {
      claims.push(ensureArtifactOwnerClaim({
        trustedRoot,
        artifactPath,
        owner,
        beforeFilesystemMutation: guard,
      }));
    }
    return claims;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const claim of [...claims].reverse()) {
      try {
        removeCreatedArtifactOwnerClaim(claim, { beforeFilesystemMutation: guard });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throwWithRollbackFailures(error, rollbackErrors);
  }
}

function rollbackPublishedFiles(
  boundary: ManagedDirectoryBoundary,
  files: PublishedFile[],
): { errors: unknown[]; preserveClaims: boolean } {
  const errors: unknown[] = [];
  let preserveClaims = false;
  for (const file of [...files].reverse()) {
    if (!file.identity) {
      preserveClaims = true;
      errors.push(new Error(`artifact publication identity unavailable: ${file.filePath}`));
      continue;
    }
    try {
      boundary.revalidatePath(file.filePath, file.identity, { kind: 'file' });
      fs.unlinkSync(file.identity.canonicalPath);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) {
        preserveClaims = true;
        errors.push(error);
      }
    }
  }
  return { errors, preserveClaims };
}

export function createLiveArtifactTransaction({
  trustedRoot,
  artifactDir,
  htmlPath,
  manifestPath,
  owner,
}: {
  trustedRoot: string;
  artifactDir: string;
  htmlPath: string;
  manifestPath: string;
  owner: unknown;
}): LiveArtifactTransaction {
  const boundary = createManagedDirectoryBoundary(artifactDir, {
    create: true,
    label: 'Live artifact directory',
  });
  const guard = boundary.createMutationGuard();
  const claims = owner === undefined
    ? []
    : reserveOwnerClaims({ boundary, guard, trustedRoot, htmlPath, manifestPath, owner });
  const publishedFiles: PublishedFile[] = [];

  return Object.freeze({
    publish(filePath: string, data: string): boolean {
      if (!writePrivateFileOnceAtomically(filePath, data, {
        beforeFilesystemMutation: guard,
      })) return false;
      const publication: PublishedFile = { filePath, identity: null };
      publishedFiles.push(publication);
      publication.identity = boundary.inspectPath(filePath, { kind: 'file' });
      if (!publication.identity) throw new Error('artifact publication disappeared');
      return true;
    },
    rollback(primary: unknown): never {
      const rollback = rollbackPublishedFiles(boundary, publishedFiles);
      let preserveClaims = rollback.preserveClaims;
      for (const protectedPath of [htmlPath, manifestPath]) {
        try {
          if (boundary.inspectPath(protectedPath, { allowMissing: true, kind: 'file' })) {
            preserveClaims = true;
          }
        } catch (error) {
          preserveClaims = true;
          rollback.errors.push(error);
        }
      }
      if (!preserveClaims) {
        for (const claim of [...claims].reverse()) {
          try {
            removeCreatedArtifactOwnerClaim(claim, { beforeFilesystemMutation: guard });
          } catch (error) {
            rollback.errors.push(error);
          }
        }
      }
      throwWithRollbackFailures(primary, rollback.errors);
    },
  });
}
