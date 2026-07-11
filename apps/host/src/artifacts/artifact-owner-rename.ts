// Owner-claim transaction for workspace rollback rename (host · L1 artifacts).
// Reserves the target claim before the move, then removes the source claim only
// after the moved file retains the source publication identity.
import path from 'node:path';

import {
  createManagedDirectoryBoundary,
} from '../security/managed-directory-boundary.js';
import {
  authorizeArtifactOwner,
  ensureArtifactOwnerClaim,
  removeAuthorizedArtifactOwnerClaim,
  removeCreatedArtifactOwnerClaim,
} from './artifact-owner.js';
import type fs from 'node:fs';
import type { ManagedPathInspection } from '../security/managed-directory-boundary.js';

const ARTIFACT_PARTS = ['.AgentCowork', 'artifacts'];

export type ArtifactOwnerRenamePreparation = Readonly<{
  beforeMutation(): void;
  commit(): void;
  abort(): void;
}>;

function artifactNotFound(): Error & { statusCode: number } {
  const error = new Error('artifact not found') as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

function artifactConflict(): Error & { statusCode: number } {
  const error = new Error('artifact target already exists') as Error & { statusCode: number };
  error.statusCode = 409;
  return error;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.isFile()
    && right.isFile()
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function changedError(): Error {
  return new Error('Artifact owner directory: managed path changed during operation');
}

function requireFile(inspection: ManagedPathInspection | null): ManagedPathInspection {
  if (!inspection) throw changedError();
  return inspection;
}

export function prepareManagedArtifactOwnerRename({
  trustedRoot,
  source,
  target,
  owner,
}: {
  trustedRoot: string;
  source: string;
  target: string;
  owner: unknown;
}): ArtifactOwnerRenamePreparation {
  const artifactRoot = path.join(path.resolve(trustedRoot), ...ARTIFACT_PARTS);
  const boundary = createManagedDirectoryBoundary(artifactRoot, {
    create: false,
    label: 'Artifact owner directory',
  });
  const guard = boundary.createMutationGuard();
  const sourceIdentity = requireFile(boundary.inspectPath(source, { kind: 'file' }));
  if (boundary.inspectPath(target, { allowMissing: true })) throw artifactConflict();
  const authorization = authorizeArtifactOwner({
    trustedRoot,
    artifactPath: source,
    context: owner,
    beforeFilesystemMutation: guard,
  });
  if (authorization.legacy) throw artifactNotFound();

  let targetClaim;
  try {
    targetClaim = ensureArtifactOwnerClaim({
      trustedRoot,
      artifactPath: target,
      owner,
      beforeFilesystemMutation: guard,
    });
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode === 404) throw artifactConflict();
    throw error;
  }
  if (!targetClaim.created) throw artifactConflict();

  function beforeMutation(): void {
    guard(source);
    guard(target);
    boundary.revalidatePath(source, sourceIdentity, { kind: 'file' });
    if (boundary.inspectPath(target, { allowMissing: true })) throw artifactConflict();
    authorizeArtifactOwner({
      trustedRoot,
      artifactPath: target,
      context: owner,
      beforeFilesystemMutation: guard,
    });
  }

  return Object.freeze({
    beforeMutation,
    commit() {
      guard(source);
      guard(target);
      const moved = requireFile(boundary.inspectPath(target, { kind: 'file' }));
      if (boundary.inspectPath(source, { allowMissing: true })
        || !sameFileIdentity(sourceIdentity.stats, moved.stats)) {
        throw changedError();
      }
      removeAuthorizedArtifactOwnerClaim({
        trustedRoot,
        artifactPath: source,
        authorization,
        beforeFilesystemMutation: guard,
      });
    },
    abort() {
      guard(source);
      guard(target);
      const sourceExists = boundary.inspectPath(source, { allowMissing: true }) !== null;
      const targetExists = boundary.inspectPath(target, { allowMissing: true }) !== null;
      if (!targetExists) {
        removeCreatedArtifactOwnerClaim(targetClaim, {
          beforeFilesystemMutation: guard,
        });
      }
      if (sourceExists) {
        ensureArtifactOwnerClaim({
          trustedRoot,
          artifactPath: source,
          owner,
          beforeFilesystemMutation: guard,
        });
      }
    },
  });
}
