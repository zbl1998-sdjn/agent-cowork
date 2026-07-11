// Stable filesystem transaction for artifact catalog rename (host · L1 artifacts).
// Keeps path-bound operations inside a captured artifact root and only rolls
// back files whose publication identity still matches this transaction.
import fs from 'node:fs';
import path from 'node:path';

import {
  createManagedDirectoryBoundary,
} from '../security/managed-directory-boundary.js';
import {
  writePrivateFileAtomically,
  writePrivateFileOnceAtomically,
} from '../security/private-atomic-file.js';
import type {
  ManagedDirectoryBoundary,
  ManagedPathInspection,
} from '../security/managed-directory-boundary.js';

const ARTIFACT_PARTS = ['.AgentCowork', 'artifacts'];

type StatusError = Error & { statusCode: number };

export type ArtifactCatalogRenameFilesystem = Readonly<{
  guardMutation(candidatePath: string): void;
  targetExists(): boolean;
  publish(): void;
  replaceTarget(data: string): void;
  deleteSource(): void;
  rollbackMove(originalSourceContent: string | null): void;
  targetStillPublished(): boolean;
  verifySource(): void;
  verifyTarget(): void;
}>;

function statusError(message: string, statusCode: number): StatusError {
  const error = new Error(message) as StatusError;
  error.statusCode = statusCode;
  return error;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === code;
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
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
  return new Error('Artifact catalog directory: managed path changed during operation');
}

function requireFile(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
): ManagedPathInspection {
  const inspection = boundary.inspectPath(filePath, { kind: 'file' });
  if (!inspection) throw changedError();
  return inspection;
}

export function createArtifactCatalogRenameFilesystem({
  trustedRoot,
  source,
  target,
}: {
  trustedRoot: string;
  source: string;
  target: string;
}): ArtifactCatalogRenameFilesystem {
  const artifactRoot = path.join(path.resolve(trustedRoot), ...ARTIFACT_PARTS);
  const boundary = createManagedDirectoryBoundary(artifactRoot, {
    create: false,
    label: 'Artifact catalog directory',
  });
  const mutationGuard = boundary.createMutationGuard();
  let sourceIdentity = requireFile(boundary, source);
  let sourceDeleted = false;
  let targetIdentity: ManagedPathInspection | null = null;

  function guardMutation(candidatePath: string): void {
    mutationGuard(candidatePath);
  }

  function assertSource(): ManagedPathInspection {
    if (sourceDeleted) throw changedError();
    return boundary.revalidatePath(source, sourceIdentity, { kind: 'file' });
  }

  function assertTarget(): ManagedPathInspection {
    if (!targetIdentity) throw changedError();
    return boundary.revalidatePath(target, targetIdentity, { kind: 'file' });
  }

  function targetExists(): boolean {
    return boundary.inspectPath(target, { allowMissing: true }) !== null;
  }

  function publish(): void {
    const currentSource = assertSource();
    if (targetExists()) throw statusError('artifact target already exists', 409);
    try {
      fs.linkSync(source, target);
    } catch (error) {
      if (isCode(error, 'EEXIST')) throw statusError('artifact target already exists', 409);
      throw error;
    }
    const sourceAfterPublish = assertSource();
    const published = requireFile(boundary, target);
    if (!sameFileIdentity(currentSource.stats, sourceAfterPublish.stats)
      || !sameFileIdentity(sourceAfterPublish.stats, published.stats)) {
      throw changedError();
    }
    targetIdentity = published;
  }

  function replaceTarget(data: string): void {
    const previous = assertTarget();
    writePrivateFileAtomically(target, data, {
      beforeFilesystemMutation(candidatePath) {
        if (samePath(candidatePath, target)) {
          boundary.revalidatePath(target, previous, { kind: 'file' });
          return;
        }
        guardMutation(candidatePath);
      },
    });
    targetIdentity = requireFile(boundary, target);
  }

  function deleteSource(): void {
    assertSource();
    try {
      fs.unlinkSync(source);
      sourceDeleted = true;
    } catch (error) {
      const current = boundary.inspectPath(source, { allowMissing: true });
      if (!current) sourceDeleted = true;
      throw error;
    }
  }

  function restoreSource(originalSourceContent: string | null): void {
    if (boundary.inspectPath(source, { allowMissing: true })) throw changedError();
    if (originalSourceContent !== null) {
      if (!writePrivateFileOnceAtomically(source, originalSourceContent, {
        beforeFilesystemMutation: guardMutation,
      })) throw statusError('artifact rollback source already exists', 409);
    } else {
      assertTarget();
      try {
        fs.linkSync(target, source);
      } catch (error) {
        if (isCode(error, 'EEXIST')) {
          throw statusError('artifact rollback source already exists', 409);
        }
        throw error;
      }
    }
    const restored = requireFile(boundary, source);
    if (originalSourceContent === null
      && !sameFileIdentity(assertTarget().stats, restored.stats)) {
      throw changedError();
    }
    sourceIdentity = restored;
    sourceDeleted = false;
  }

  function removePublishedTarget(): void {
    assertTarget();
    try {
      fs.unlinkSync(target);
      targetIdentity = null;
    } catch (error) {
      if (!boundary.inspectPath(target, { allowMissing: true })) targetIdentity = null;
      throw error;
    }
  }

  function rollbackMove(originalSourceContent: string | null): void {
    if (!targetIdentity) {
      if (!sourceDeleted) assertSource();
      else throw changedError();
      return;
    }
    if (sourceDeleted) restoreSource(originalSourceContent);
    else assertSource();
    removePublishedTarget();
  }

  function targetStillPublished(): boolean {
    if (!targetIdentity) return false;
    try {
      boundary.revalidatePath(target, targetIdentity, { kind: 'file' });
      return true;
    } catch {
      return false;
    }
  }

  function verifyTarget(): void {
    assertTarget();
  }

  return Object.freeze({
    guardMutation,
    targetExists,
    publish,
    replaceTarget,
    deleteSource,
    rollbackMove,
    targetStillPublished,
    verifySource: () => {
      assertSource();
    },
    verifyTarget,
  });
}
