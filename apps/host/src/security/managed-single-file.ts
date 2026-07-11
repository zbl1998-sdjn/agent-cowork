// Stable single-file operation inside a pinned private directory (host · L0).
// One operation guard spans descriptor reads and atomic replacement so a
// read-modify-write sequence cannot silently continue in a replaced parent.
import path from 'node:path';

import { createManagedDirectoryBoundary } from './managed-directory-boundary.js';
import { readPrivateManagedFile } from './managed-private-file.js';
import { writePrivateFileAtomically } from './private-atomic-file.js';

export type ManagedSingleFileOperation = Readonly<{
  filePath: string;
  readText(options?: Readonly<{ maxBytes?: number }>): string | null;
  writeText(contents: string): void;
}>;

function assertByteLimit(value: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && value > maxBytes) {
    throw new Error(`managed private file exceeds byte limit of ${maxBytes}`);
  }
}

export function createManagedSingleFileOperation(
  fileInput: string,
  label = 'managed private file',
): ManagedSingleFileOperation {
  const filePath = path.resolve(fileInput);
  const boundary = createManagedDirectoryBoundary(path.dirname(filePath), {
    create: true,
    label,
  });
  const guard = boundary.createMutationGuard();

  return {
    filePath,
    readText({ maxBytes }: Readonly<{ maxBytes?: number }> = {}): string | null {
      guard(filePath);
      const before = boundary.inspectPath(filePath, { allowMissing: true, kind: 'file' });
      if (!before) return null;
      assertByteLimit(before.stats.size, maxBytes);
      const contents = readPrivateManagedFile(boundary, filePath, guard);
      if (contents === null) throw new Error(`${label}: managed file disappeared during operation`);
      assertByteLimit(Buffer.byteLength(contents, 'utf8'), maxBytes);
      return contents;
    },
    writeText(contents: string): void {
      guard(filePath);
      boundary.inspectPath(filePath, { allowMissing: true, kind: 'file' });
      writePrivateFileAtomically(filePath, contents, {
        beforeFilesystemMutation: guard,
      });
      guard(filePath);
      boundary.inspectPath(filePath, { kind: 'file' });
    },
  };
}
