// Descriptor-based private file operations inside a pinned managed directory.
// Every path-sensitive operation is bracketed by the same operation guard; an
// opened descriptor must also resolve to the inspected regular file.
import fs from 'node:fs';

import type {
  ManagedDirectoryBoundary,
  ManagedPathInspection,
} from './managed-directory-boundary.js';

type MutationGuard = (candidatePath: string) => void;
type FileSystemExtensions = {
  fchmodSync(descriptor: number, mode: number): void;
  fstatSync(descriptor: number): fs.Stats;
  ftruncateSync(descriptor: number, length: number): void;
  readFileSync(descriptor: number, encoding: string): string;
};

const fileSystem = fs as unknown as FileSystemExtensions;

function sameFileNode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.isFile()
    && right.isFile();
}

function verifyDescriptor(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  descriptor: number,
  guard: MutationGuard,
): ManagedPathInspection {
  guard(filePath);
  const current = boundary.inspectPath(filePath, { kind: 'file' });
  if (!current || !sameFileNode(current.stats, fileSystem.fstatSync(descriptor))) {
    throw new Error('managed file changed during operation');
  }
  return current;
}

function openManaged(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  flags: string,
  mode: number | undefined,
  guard: MutationGuard,
  allowMissing: boolean,
): number {
  guard(filePath);
  const before = boundary.inspectPath(filePath, { allowMissing, kind: 'file' });
  const descriptor = fs.openSync(before?.canonicalPath ?? filePath, flags, mode);
  try {
    verifyDescriptor(boundary, filePath, descriptor, guard);
    if (before) boundary.revalidatePath(filePath, before, { kind: 'file' });
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function guardedDescriptorOperation<T>(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  descriptor: number,
  guard: MutationGuard,
  operation: () => T,
): T {
  verifyDescriptor(boundary, filePath, descriptor, guard);
  const result = operation();
  verifyDescriptor(boundary, filePath, descriptor, guard);
  return result;
}

function writeDescriptor(descriptor: number, contents: string): void {
  const write = fs.writeFileSync as unknown as (
    target: number,
    data: string,
    encoding: string,
  ) => void;
  write(descriptor, contents, 'utf8');
}

function mutatePrivateDescriptor(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  contents: string,
  flags: 'a' | 'wx',
  guard: MutationGuard,
): void {
  const descriptor = openManaged(boundary, filePath, flags, 0o600, guard, true);
  try {
    guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => {
      fileSystem.fchmodSync(descriptor, 0o600);
    });
    guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => {
      writeDescriptor(descriptor, contents);
    });
    guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => {
      fs.fsyncSync(descriptor);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function appendPrivateManagedFile(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  contents: string,
  guard = boundary.createMutationGuard(),
): void {
  mutatePrivateDescriptor(boundary, filePath, contents, 'a', guard);
}

export function writePrivateManagedFile(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  contents: string,
  guard = boundary.createMutationGuard(),
): void {
  mutatePrivateDescriptor(boundary, filePath, contents, 'wx', guard);
}

export function syncPrivateManagedFile(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  guard = boundary.createMutationGuard(),
): void {
  const descriptor = openManaged(boundary, filePath, 'r+', undefined, guard, false);
  try {
    guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => {
      fileSystem.fchmodSync(descriptor, 0o600);
    });
    guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => {
      fs.fsyncSync(descriptor);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function truncatePrivateManagedFile(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  length: number,
  guard = boundary.createMutationGuard(),
): void {
  const descriptor = openManaged(boundary, filePath, 'r+', undefined, guard, false);
  try {
    guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => {
      fileSystem.ftruncateSync(descriptor, length);
    });
    guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => {
      fs.fsyncSync(descriptor);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPrivateManagedFile(
  boundary: ManagedDirectoryBoundary,
  filePath: string,
  guard = boundary.createMutationGuard(),
): string | null {
  guard(filePath);
  if (!boundary.inspectPath(filePath, { allowMissing: true, kind: 'file' })) return null;
  const descriptor = openManaged(boundary, filePath, 'r', undefined, guard, false);
  try {
    return guardedDescriptorOperation(boundary, filePath, descriptor, guard, () => (
      fileSystem.readFileSync(descriptor, 'utf8')
    ));
  } finally {
    fs.closeSync(descriptor);
  }
}
