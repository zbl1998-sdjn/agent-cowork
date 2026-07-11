// Owner-scoped memory filesystem boundary (host · L1 memory over L0 security).
// One operation pins every existing directory segment so reads and later
// atomic mutations cannot silently cross a replaced owner namespace.
import fs from 'node:fs';
import path from 'node:path';

import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
} from '../security/managed-directory-boundary.js';
import { readPrivateManagedFile } from '../security/managed-private-file.js';
import { AtRestKeyError, openAtRest } from '../security/at-rest.js';
import { ensureTrustedRoot, safeWriteSync, securityDirForMemoryPath } from './memory-utils.js';

export class MemoryFilesystemBoundaryError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    super(`Memory storage boundary rejected filesystem access${detail}`, { cause });
    this.name = 'MemoryFilesystemBoundaryError';
  }
}

function runWithinBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AtRestKeyError || error instanceof MemoryFilesystemBoundaryError) throw error;
    throw new MemoryFilesystemBoundaryError(error);
  }
}

export type MemoryFilesystemOperation = Readonly<{
  root: string;
  boundary: ManagedDirectoryBoundary;
  guardMutation: (candidatePath: string) => void;
}>;

export type ManagedMemoryFile = Readonly<{
  name: string;
  path: string;
  stats: fs.Stats;
}>;

export function beginMemoryFilesystemOperation(
  trustedRoot: unknown,
): MemoryFilesystemOperation {
  const root = ensureTrustedRoot(trustedRoot);
  const boundary = runWithinBoundary(() => createManagedDirectoryBoundary(root, {
    create: false,
    label: 'Memory storage boundary',
  }));
  return {
    root,
    boundary,
    guardMutation: boundary.createMutationGuard(),
  };
}

export function readManagedMemoryFile(
  operation: MemoryFilesystemOperation,
  filePath: string,
  fallback = '',
): { exists: boolean; body: string } {
  const raw = runWithinBoundary(() => {
    operation.guardMutation(filePath);
    return readPrivateManagedFile(
      operation.boundary,
      filePath,
      operation.guardMutation,
    );
  });
  if (raw === null) return { exists: false, body: fallback };
  const opened = openAtRest(raw, securityDirForMemoryPath(filePath));
  if (opened === null) throw new Error('memory file is corrupt or cannot be decrypted');
  runWithinBoundary(() => operation.guardMutation(filePath));
  return { exists: true, body: opened };
}

export function writeManagedMemoryFile(
  operation: MemoryFilesystemOperation,
  filePath: string,
  body: string,
): void {
  runWithinBoundary(() => {
    operation.guardMutation(filePath);
    operation.boundary.inspectPath(filePath, { allowMissing: true, kind: 'file' });
    safeWriteSync(filePath, body, {
      beforeFilesystemMutation: operation.guardMutation,
    });
    operation.guardMutation(filePath);
    if (!operation.boundary.inspectPath(filePath, { kind: 'file' })) {
      throw new Error('published file is unavailable');
    }
  });
}

export function listManagedMemoryFiles(
  operation: MemoryFilesystemOperation,
  directory: string,
  includeName: (name: string) => boolean = () => true,
): ManagedMemoryFile[] {
  return runWithinBoundary(() => {
    operation.guardMutation(directory);
    const beforeDirectory = operation.boundary.inspectPath(directory, {
      allowMissing: true,
      kind: 'directory',
    });
    if (!beforeDirectory) return [];
    const files: ManagedMemoryFile[] = [];
    for (const name of fs.readdirSync(beforeDirectory.canonicalPath)) {
      if (!includeName(name)) continue;
      const filePath = path.join(directory, name);
      const beforeFile = operation.boundary.inspectPath(filePath, { kind: 'file' });
      if (!beforeFile) throw new Error('listed file is unavailable');
      operation.boundary.revalidatePath(filePath, beforeFile, { kind: 'file' });
      files.push({ name, path: filePath, stats: beforeFile.stats });
    }
    operation.boundary.revalidatePath(directory, beforeDirectory, { kind: 'directory' });
    operation.guardMutation(directory);
    return files;
  });
}

export function removeManagedMemoryFile(
  operation: MemoryFilesystemOperation,
  filePath: string,
): boolean {
  return runWithinBoundary(() => {
    operation.guardMutation(filePath);
    const before = operation.boundary.inspectPath(filePath, {
      allowMissing: true,
      kind: 'file',
    });
    if (!before) return false;
    operation.boundary.revalidatePath(filePath, before, { kind: 'file' });
    operation.guardMutation(filePath);
    fs.unlinkSync(before.canonicalPath);
    operation.guardMutation(filePath);
    if (operation.boundary.inspectPath(filePath, { allowMissing: true, kind: 'file' })) {
      throw new Error('deleted file was replaced');
    }
    return true;
  });
}
