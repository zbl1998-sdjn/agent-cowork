// Stable private-file operations rooted in one pinned managed directory.
// Path-boundary failures are typed so callers may preserve content-level
// best-effort behavior without swallowing filesystem identity changes.
import fs from 'node:fs';
import path from 'node:path';

import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
  type ManagedPathInspection,
  type ManagedPathKind,
} from './managed-directory-boundary.js';
import { readPrivateManagedFile } from './managed-private-file.js';
import { writePrivateFileAtomically } from './private-atomic-file.js';

type ManagedStateFilesystemOptions = Readonly<{
  create?: boolean;
  label?: string;
  beforeFilesystemMutation?: (candidatePath: string) => void;
}>;

function isAtRestKeyFailure(error: unknown): error is Error & { code: 'AT_REST_KEY_ERROR' } {
  return error instanceof Error
    && (error as Error & { code?: unknown }).code === 'AT_REST_KEY_ERROR';
}

export class ManagedStatePathError extends Error {
  constructor(message: string, cause?: unknown) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    super(`${message}${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'ManagedStatePathError';
  }
}

export class ManagedStateFilesystem {
  readonly rootPath: string;
  readonly boundary: ManagedDirectoryBoundary;
  readonly guardMutation: (candidatePath: string) => void;
  private readonly label: string;
  private readonly knownFiles = new Map<string, ManagedPathInspection>();

  constructor(
    rootInput: string,
    {
      create = true,
      label = 'Managed state',
      beforeFilesystemMutation,
    }: ManagedStateFilesystemOptions = {},
  ) {
    this.rootPath = path.resolve(rootInput);
    this.label = label;
    try {
      this.boundary = createManagedDirectoryBoundary(this.rootPath, { create, label });
      const operationGuard = this.boundary.createMutationGuard();
      this.guardMutation = (candidatePath) => {
        beforeFilesystemMutation?.(candidatePath);
        this.protect(() => operationGuard(candidatePath));
      };
    } catch (cause) {
      throw this.pathError(cause);
    }
  }

  private pathError(cause: unknown): ManagedStatePathError {
    if (cause instanceof ManagedStatePathError) return cause;
    return new ManagedStatePathError(
      `${this.label}: path boundary rejected filesystem access`,
      cause,
    );
  }

  private protect<T>(operation: () => T): T {
    try {
      return operation();
    } catch (cause) {
      // Keep the L0 filesystem helper independent from the L1 at-rest module
      // while preserving its public typed infrastructure failure unchanged.
      if (isAtRestKeyFailure(cause)) throw cause;
      throw this.pathError(cause);
    }
  }

  private inspect(
    candidatePath: string,
    allowMissing: boolean,
    kind: ManagedPathKind,
  ): ManagedPathInspection | null {
    return this.protect(() => this.boundary.inspectPath(candidatePath, { allowMissing, kind }));
  }

  private revalidate(
    candidatePath: string,
    previous: ManagedPathInspection,
    kind: ManagedPathKind,
  ): ManagedPathInspection {
    return this.protect(() => this.boundary.revalidatePath(candidatePath, previous, { kind }));
  }

  private remember(filePath: string, inspection: ManagedPathInspection): void {
    this.knownFiles.set(path.resolve(filePath), inspection);
  }

  private revalidateKnown(filePath: string): void {
    const known = this.knownFiles.get(path.resolve(filePath));
    if (known) this.revalidate(filePath, known, 'file');
  }

  fileExists(filePath: string): boolean {
    this.revalidateKnown(filePath);
    const inspection = this.inspect(filePath, true, 'file');
    if (!inspection) {
      this.knownFiles.delete(path.resolve(filePath));
      return false;
    }
    this.remember(filePath, inspection);
    return true;
  }

  readFile(filePath: string): string | null {
    this.revalidateKnown(filePath);
    const raw = this.protect(() => (
      readPrivateManagedFile(this.boundary, filePath, this.guardMutation)
    ));
    if (raw === null) {
      this.knownFiles.delete(path.resolve(filePath));
      return null;
    }
    const current = this.inspect(filePath, false, 'file');
    if (!current) throw this.pathError(new Error('managed file is unavailable'));
    this.remember(filePath, current);
    return raw;
  }

  listFiles(
    directoryPath: string,
    acceptName: (name: string) => boolean,
  ): string[] {
    const before = this.inspect(directoryPath, true, 'directory');
    if (!before) return [];
    const entries = this.protect(() => fs.readdirSync(before.canonicalPath, { withFileTypes: true }));
    this.revalidate(directoryPath, before, 'directory');
    const files: string[] = [];
    for (const entry of entries) {
      if (!acceptName(entry.name)) continue;
      const filePath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        this.inspect(filePath, false, 'file');
      }
      if (!entry.isFile()) continue;
      const inspection = this.inspect(filePath, false, 'file');
      if (!inspection) throw this.pathError(new Error('managed file is unavailable'));
      this.remember(filePath, inspection);
      files.push(filePath);
    }
    this.revalidate(directoryPath, before, 'directory');
    return files;
  }

  writeFile(filePath: string, data: string): void {
    this.revalidateKnown(filePath);
    this.guardMutation(filePath);
    this.protect(() => writePrivateFileAtomically(filePath, data, {
      beforeFilesystemMutation: this.guardMutation,
    }));
    this.guardMutation(filePath);
    const current = this.inspect(filePath, false, 'file');
    if (!current) throw this.pathError(new Error('managed file was not published'));
    this.remember(filePath, current);
  }

  removeFile(
    filePath: string,
    beforeFilesystemMutation?: (candidatePath: string) => void,
  ): boolean {
    const guard = (candidatePath: string): void => {
      beforeFilesystemMutation?.(candidatePath);
      this.guardMutation(candidatePath);
    };
    guard(filePath);
    this.revalidateKnown(filePath);
    const before = this.inspect(filePath, true, 'file');
    if (!before) return false;
    guard(filePath);
    this.revalidate(filePath, before, 'file');
    this.protect(() => fs.unlinkSync(before.canonicalPath));
    guard(filePath);
    if (this.inspect(filePath, true, 'file')) {
      throw this.pathError(new Error('deleted managed file was replaced'));
    }
    this.knownFiles.delete(path.resolve(filePath));
    return true;
  }
}
