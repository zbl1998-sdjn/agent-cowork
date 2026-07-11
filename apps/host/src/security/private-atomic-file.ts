// Private atomic file replacement (host · L0 security).
// A random, exclusively-created sibling is fully closed before rename. Cleanup
// only ever removes a path this process successfully opened with `wx`.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type AtomicWriteOptions = Readonly<{
  randomSuffix?: () => string;
  beforeFilesystemMutation?: (candidatePath: string) => void;
}>;

const ATOMIC_SUFFIX_RE = /^[A-Za-z0-9-]{1,128}$/;
function writeFileDescriptor(descriptor: number, data: string): void {
  const write = fs.writeFileSync as unknown as (
    target: number,
    content: string,
    encoding: string,
  ) => void;
  write(descriptor, data, 'utf8');
}

function guardFilesystemMutation(options: AtomicWriteOptions, candidatePath: string): void {
  options.beforeFilesystemMutation?.(candidatePath);
}

function cleanupOwnedTemporaryFile(
  temporaryFile: string,
  options: AtomicWriteOptions,
): void {
  try {
    guardFilesystemMutation(options, temporaryFile);
    fs.unlinkSync(temporaryFile);
  } catch {
    // Cleanup must never replace the primary write/publish failure. If the
    // path guard rejects a swapped parent, leaving our displaced temp is safer
    // than unlinking an attacker-controlled path.
  }
}

export function writePrivateFileAtomically(
  filePath: string,
  data: string,
  options: AtomicWriteOptions = {},
): void {
  const directory = path.dirname(filePath);
  const suffix = (options.randomSuffix ?? randomUUID)();
  if (!ATOMIC_SUFFIX_RE.test(suffix)) {
    throw new Error('Invalid atomic file suffix');
  }
  guardFilesystemMutation(options, directory);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`,
  );
  let descriptor: number | null = null;
  let ownsTemporaryFile = false;
  try {
    guardFilesystemMutation(options, temporaryFile);
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    ownsTemporaryFile = true;
    writeFileDescriptor(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    guardFilesystemMutation(options, temporaryFile);
    guardFilesystemMutation(options, filePath);
    fs.renameSync(temporaryFile, filePath);
    ownsTemporaryFile = false;
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original write error */ }
    }
    if (ownsTemporaryFile) {
      cleanupOwnedTemporaryFile(temporaryFile, options);
    }
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'EEXIST';
}

/**
 * Atomically publishes a private file only when the destination is absent.
 * Returns false when another writer already published the destination.
 */
export function writePrivateFileOnceAtomically(
  filePath: string,
  data: string,
  options: AtomicWriteOptions = {},
): boolean {
  const directory = path.dirname(filePath);
  const suffix = (options.randomSuffix ?? randomUUID)();
  if (!ATOMIC_SUFFIX_RE.test(suffix)) {
    throw new Error('Invalid atomic file suffix');
  }
  guardFilesystemMutation(options, directory);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`,
  );
  let descriptor: number | null = null;
  let ownsTemporaryFile = false;
  let published = false;
  try {
    guardFilesystemMutation(options, temporaryFile);
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    ownsTemporaryFile = true;
    writeFileDescriptor(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      const linkSync = (fs as unknown as {
        linkSync(source: string, destination: string): void;
      }).linkSync;
      guardFilesystemMutation(options, temporaryFile);
      guardFilesystemMutation(options, filePath);
      linkSync(temporaryFile, filePath);
      published = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    guardFilesystemMutation(options, temporaryFile);
    fs.unlinkSync(temporaryFile);
    ownsTemporaryFile = false;
    return published;
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original publish error */ }
    }
    if (ownsTemporaryFile) {
      cleanupOwnedTemporaryFile(temporaryFile, options);
    }
    throw error;
  }
}
