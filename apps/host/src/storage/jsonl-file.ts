// Strict JSONL persistence helpers (host · L1 storage).
// Readers tolerate only one syntactically incomplete final record. Writers
// repair that tail, preserve a valid unterminated record, and append through a
// 0600 descriptor that is fsynced before close.
import fs from 'node:fs';
import path from 'node:path';
import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
} from '../security/managed-directory-boundary.js';
import {
  appendPrivateManagedFile,
  readPrivateManagedFile,
  truncatePrivateManagedFile,
} from '../security/managed-private-file.js';

type JsonlValidator<T> = (value: unknown) => T;
type JsonlLine = Readonly<{ text: string; start: number }>;
type JsonlInspection<T> = Readonly<{
  records: T[];
  recoveryOffset: number | null;
}>;
export type JsonlManagedAccess = Readonly<{
  boundary: ManagedDirectoryBoundary;
  guardMutation: (candidatePath: string) => void;
}>;

function managedAccess(
  resolved: string,
  label: string,
  create: boolean,
  access?: JsonlManagedAccess,
): JsonlManagedAccess | null {
  if (access) {
    access.guardMutation(resolved);
    return access;
  }
  const directory = path.dirname(resolved);
  if (!create && !fs.existsSync(directory)) return null;
  const boundary = createManagedDirectoryBoundary(directory, {
    create,
    label: `${label} JSONL directory`,
  });
  return { boundary, guardMutation: boundary.createMutationGuard() };
}

function jsonlLines(raw: string): JsonlLine[] {
  const lines: JsonlLine[] = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== '\n') continue;
    const text = raw.slice(start, index).replace(/\r$/, '');
    if (text.trim()) lines.push({ text, start });
    start = index + 1;
  }
  return lines;
}

function invalidJsonl(label: string, line: number, cause: unknown): Error {
  const error = new Error(`${label} JSONL record ${line} is invalid`);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function inspectJsonl<T>(raw: string, label: string, validate: JsonlValidator<T>): JsonlInspection<T> {
  const lines = jsonlLines(raw);
  const records: T[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(validate(JSON.parse(line.text) as unknown));
    } catch (cause) {
      if (index === lines.length - 1 && cause instanceof SyntaxError) {
        return { records, recoveryOffset: line.start };
      }
      if (cause instanceof SyntaxError) throw cause;
      throw invalidJsonl(label, index + 1, cause);
    }
  }
  return { records, recoveryOffset: null };
}

export function readValidatedJsonl<T>(
  filePath: string,
  label: string,
  validate: JsonlValidator<T>,
  access?: JsonlManagedAccess,
): T[] {
  const resolved = path.resolve(filePath);
  const managed = managedAccess(resolved, label, false, access);
  if (!managed) return [];
  const raw = readPrivateManagedFile(
    managed.boundary,
    resolved,
    managed.guardMutation,
  ) ?? '';
  return inspectJsonl(raw, label, validate).records;
}

export function appendValidatedJsonl<T>(
  filePath: string,
  value: T,
  label: string,
  validate: JsonlValidator<T>,
  access?: JsonlManagedAccess,
): void {
  const validated = validate(value);
  const resolved = path.resolve(filePath);
  const managed = managedAccess(resolved, label, true, access);
  if (!managed) throw new Error(`${label} JSONL directory is unavailable`);
  const { boundary, guardMutation: guard } = managed;
  const raw = readPrivateManagedFile(boundary, resolved, guard) ?? '';
  const inspection = inspectJsonl(raw, label, validate);
  let separator = raw && !raw.endsWith('\n') ? '\n' : '';
  if (inspection.recoveryOffset !== null) {
    const prefix = raw.slice(0, inspection.recoveryOffset);
    truncatePrivateManagedFile(boundary, resolved, Buffer.byteLength(prefix, 'utf8'), guard);
    separator = prefix && !prefix.endsWith('\n') ? '\n' : '';
  }
  appendPrivateManagedFile(boundary, resolved, `${separator}${JSON.stringify(validated)}\n`, guard);
}
