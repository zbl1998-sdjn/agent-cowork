// Credential disk snapshot I/O (host · L0 · security).
// Reads are best-effort for status/list compatibility; read-modify-write callers
// use the strict reader and atomic same-directory replacement.
import { types as utilTypes } from 'node:util';
import {
  createManagedSingleFileOperation,
  type ManagedSingleFileOperation,
} from './managed-single-file.js';

export type CredentialDiskFile = {
  schemaVersion: 1;
  entries: Record<string, unknown>;
};

function plainDataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  return value as Record<string, unknown>;
}

function decodeCredentialDiskFile(value: unknown): CredentialDiskFile | null {
  const root = plainDataRecord(value);
  if (!root) return null;
  const rootKeys = Reflect.ownKeys(root).sort();
  if (
    rootKeys.length !== 2
    || rootKeys[0] !== 'entries'
    || rootKeys[1] !== 'schemaVersion'
  ) return null;
  const schemaVersion = Object.getOwnPropertyDescriptor(root, 'schemaVersion')?.value;
  const entriesValue = Object.getOwnPropertyDescriptor(root, 'entries')?.value;
  const entries = plainDataRecord(entriesValue);
  return schemaVersion === 1 && entries
    ? { schemaVersion: 1, entries }
    : null;
}

function parseCredentialDiskFile(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('credential disk file is corrupt or invalid');
  }
}

export function createCredentialDiskFileOperation(filePath: string): ManagedSingleFileOperation {
  return createManagedSingleFileOperation(filePath, 'Credential store directory');
}

export function readCredentialDiskFile(
  filePath: string,
  operation = createCredentialDiskFileOperation(filePath),
): CredentialDiskFile {
  const serialized = operation.readText();
  if (serialized === null) return { schemaVersion: 1, entries: {} };
  return decodeCredentialDiskFile(parseCredentialDiskFile(serialized))
    || { schemaVersion: 1, entries: {} };
}

export function readCredentialDiskFileForWrite(
  filePath: string,
  operation = createCredentialDiskFileOperation(filePath),
): CredentialDiskFile {
  const serialized = operation.readText();
  if (serialized === null) return { schemaVersion: 1, entries: {} };
  const decoded = decodeCredentialDiskFile(parseCredentialDiskFile(serialized));
  if (!decoded) throw new Error('credential disk file is corrupt or invalid');
  return decoded;
}

export function writeCredentialDiskFile(
  filePath: string,
  data: CredentialDiskFile,
  operation = createCredentialDiskFileOperation(filePath),
): void {
  operation.writeText(JSON.stringify(data, null, 2) + '\n');
}

export function credentialEntriesWithoutKey(
  entries: Record<string, unknown>,
  keyToRemove: string,
): Record<string, unknown> {
  const { [keyToRemove]: _removed, ...remaining } = entries;
  return remaining;
}
