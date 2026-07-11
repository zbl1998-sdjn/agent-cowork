// Conversation filesystem boundary (host · L1 storage over L0 path security).
// Pins trustedRoot, rejects links in every managed segment, and validates file
// or directory identity around reads and mutations.
import fs from 'node:fs';
import path from 'node:path';
import { AtRestKeyError } from '../security/at-rest.js';
import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
  type ManagedPathInspection,
  type ManagedPathKind,
} from '../security/managed-directory-boundary.js';
import { writePrivateFileAtomically } from '../security/private-atomic-file.js';

export class ConversationPathError extends Error {
  constructor(message: string, cause?: unknown) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    super(`${message}${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'ConversationPathError';
  }
}

function trustedRootFrom(input: unknown): string {
  const root = String(input || '').trim();
  if (!root) throw new ConversationPathError('Conversation path boundary: trustedRoot is required');
  return path.resolve(root);
}

export class ConversationFileBoundary {
  readonly trustedRoot: string;
  readonly conversationsRoot: string;
  readonly securityDirectory: string;
  private readonly boundary: ManagedDirectoryBoundary;
  private readonly mutationGuard: (candidatePath: string) => void;

  constructor(trustedRoot: unknown) {
    this.trustedRoot = trustedRootFrom(trustedRoot);
    this.conversationsRoot = path.join(this.trustedRoot, '.AgentCowork', 'conversations');
    this.securityDirectory = path.join(this.trustedRoot, '.AgentCowork', 'security');
    try {
      this.boundary = createManagedDirectoryBoundary(this.trustedRoot, {
        create: false,
        label: 'Conversation path boundary',
      });
      this.mutationGuard = this.boundary.createMutationGuard();
    } catch (error) {
      throw this.pathError(error);
    }
  }

  ownerDirectory(ownerKey: string): string {
    return path.join(this.conversationsRoot, ownerKey);
  }

  legacyDirectory(segments: readonly string[]): string {
    return path.join(this.conversationsRoot, ...segments);
  }

  file(directory: string, name: string): string {
    return path.join(directory, name);
  }

  private pathError(cause: unknown): ConversationPathError | AtRestKeyError {
    if (cause instanceof AtRestKeyError) return cause;
    if (cause instanceof ConversationPathError) return cause;
    return new ConversationPathError('Conversation path boundary rejected filesystem access', cause);
  }

  private inspect(
    candidatePath: string,
    allowMissing: boolean,
    kind: ManagedPathKind,
  ): ManagedPathInspection | null {
    try {
      return this.boundary.inspectPath(candidatePath, { allowMissing, kind });
    } catch (error) {
      throw this.pathError(error);
    }
  }

  private revalidate(
    candidatePath: string,
    before: ManagedPathInspection,
    kind: ManagedPathKind,
  ): void {
    try {
      this.boundary.revalidatePath(candidatePath, before, { kind });
    } catch (error) {
      throw this.pathError(error);
    }
  }

  guardMutation(candidatePath: string): void {
    try {
      this.mutationGuard(candidatePath);
    } catch (error) {
      throw this.pathError(error);
    }
  }

  assertDirectory(directory: string): void {
    this.inspect(directory, true, 'directory');
  }

  readDirectory(directory: string): string[] | null {
    const before = this.inspect(directory, true, 'directory');
    if (!before) return null;
    let names: string[];
    try {
      names = fs.readdirSync(before.canonicalPath);
    } catch (error) {
      throw this.pathError(error);
    }
    this.revalidate(directory, before, 'directory');
    return names;
  }

  readFile(file: string): string | null {
    const before = this.inspect(file, true, 'file');
    if (!before) return null;
    let text: string;
    try {
      text = fs.readFileSync(before.canonicalPath, 'utf8');
    } catch (error) {
      throw this.pathError(error);
    }
    this.revalidate(file, before, 'file');
    return text;
  }

  fileExists(file: string): boolean {
    return Boolean(this.inspect(file, true, 'file'));
  }

  writeFile(file: string, data: string): void {
    this.guardMutation(file);
    try {
      writePrivateFileAtomically(file, data, {
        beforeFilesystemMutation: (candidatePath) => this.guardMutation(candidatePath),
      });
    } catch (error) {
      throw this.pathError(error);
    }
    this.guardMutation(file);
    this.inspect(file, false, 'file');
  }

  removeFile(file: string): boolean {
    const before = this.inspect(file, true, 'file');
    if (!before) return false;
    this.guardMutation(file);
    this.revalidate(file, before, 'file');
    try {
      fs.unlinkSync(before.canonicalPath);
    } catch (error) {
      throw this.pathError(error);
    }
    this.guardMutation(file);
    if (this.inspect(file, true, 'file')) {
      throw new ConversationPathError('Conversation path boundary: deleted file was replaced');
    }
    return true;
  }
}
