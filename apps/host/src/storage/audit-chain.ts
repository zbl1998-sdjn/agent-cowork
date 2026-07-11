// Tamper-evident audit hash chain helpers.
// ---------------------------------------------------------------------------
// Responsibilities: create deterministic per-line hashes for JSONL audit
// records and verify that a chain has not been modified after writing.
import crypto from 'node:crypto';
import path from 'node:path';
import { createManagedDirectoryBoundary } from '../security/managed-directory-boundary.js';
import { readPrivateManagedFile } from '../security/managed-private-file.js';

export const AUDIT_CHAIN_VERSION = 1;
export const AUDIT_HASH_ALGORITHM = 'sha256';

export type AuditChainRecord = Record<string, unknown> & {
  chain_version?: unknown;
  hash_algorithm?: unknown;
  prev_hash?: unknown;
  event_hash?: unknown;
};

export type AuditChainVerification = {
  ok: boolean;
  checked: number;
  failureIndex?: number;
  reason?: string;
};

export type VerifyAuditHashChainOptions = {
  initialPrevHash?: string | null;
  allowExternalPreviousHash?: boolean;
  allowLegacyPrefix?: boolean;
};

export type AuditTextReader = () => string | null;

export class AuditIntegrityError extends Error {
  readonly code = 'AUDIT_INTEGRITY_ERROR';
  readonly statusCode = 500;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AuditIntegrityError';
    if (typeof cause !== 'undefined') {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function readAuditText(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  let boundary;
  try {
    boundary = createManagedDirectoryBoundary(path.dirname(resolved), {
      create: false,
      label: 'audit log directory',
    });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const guard = boundary.createMutationGuard();
  return readPrivateManagedFile(boundary, resolved, guard);
}

function normaliseForHash(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normaliseForHash(item));
  }
  if (!isRecord(value)) {
    return String(value);
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'event_hash') continue;
    const nested = value[key];
    if (typeof nested === 'undefined' || typeof nested === 'function') continue;
    out[key] = normaliseForHash(nested);
  }
  return out;
}

export function hashAuditRecord(record: AuditChainRecord): string {
  const canonical = JSON.stringify(normaliseForHash(record));
  return crypto.createHash(AUDIT_HASH_ALGORITHM).update(canonical).digest('hex');
}

export function createAuditChainRecord(event: Record<string, unknown>, previousHash: string | null = null): AuditChainRecord {
  const record: AuditChainRecord = {
    ...event,
    chain_version: AUDIT_CHAIN_VERSION,
    hash_algorithm: AUDIT_HASH_ALGORITHM,
    prev_hash: previousHash,
  };
  return {
    ...record,
    event_hash: hashAuditRecord(record),
  };
}

export function readLastAuditHash(
  filePath: string,
  readText: AuditTextReader = () => readAuditText(filePath),
): string | null {
  const text = readText();
  if (text === null) return null;
  const records: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/g).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch (cause) {
      throw new AuditIntegrityError(`audit log contains invalid JSON at line ${index + 1}`, cause);
    }
  }

  const verification = verifyAuditHashChain(records, {
    allowExternalPreviousHash: true,
    allowLegacyPrefix: true,
  });
  if (!verification.ok) {
    throw new AuditIntegrityError(
      `audit log integrity check failed at record ${(verification.failureIndex ?? 0) + 1}: ${verification.reason || 'invalid chain'}`,
    );
  }
  for (const record of records.slice().reverse()) {
    if (isRecord(record) && typeof record.event_hash === 'string' && record.event_hash) {
      return record.event_hash;
    }
  }
  return null;
}

export function verifyAuditHashChain(
  records: unknown[],
  {
    initialPrevHash = null,
    allowExternalPreviousHash = false,
    allowLegacyPrefix = false,
  }: VerifyAuditHashChainOptions = {},
): AuditChainVerification {
  let expectedPrevHash = initialPrevHash;
  let checked = 0;
  let chainStarted = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!isRecord(record)) {
      return { ok: false, checked, failureIndex: index, reason: 'record is not an object' };
    }

    const hasChainFields = typeof record.event_hash === 'string' || typeof record.prev_hash !== 'undefined';
    if (!hasChainFields && allowLegacyPrefix && !chainStarted) {
      continue;
    }
    chainStarted = true;

    if (typeof record.event_hash !== 'string' || !record.event_hash) {
      return { ok: false, checked, failureIndex: index, reason: 'missing event_hash' };
    }
    if (record.hash_algorithm !== AUDIT_HASH_ALGORITHM) {
      return { ok: false, checked, failureIndex: index, reason: 'unsupported hash_algorithm' };
    }
    if (record.chain_version !== AUDIT_CHAIN_VERSION) {
      return { ok: false, checked, failureIndex: index, reason: 'unsupported chain_version' };
    }

    const actualPrevHash = typeof record.prev_hash === 'string' ? record.prev_hash : null;
    if (checked === 0 && allowExternalPreviousHash && initialPrevHash === null) {
      expectedPrevHash = actualPrevHash;
    }
    if (actualPrevHash !== expectedPrevHash) {
      return { ok: false, checked, failureIndex: index, reason: 'prev_hash mismatch' };
    }

    const expectedEventHash = hashAuditRecord(record);
    if (record.event_hash !== expectedEventHash) {
      return { ok: false, checked, failureIndex: index, reason: 'event_hash mismatch' };
    }
    expectedPrevHash = record.event_hash;
    checked += 1;
  }

  return { ok: true, checked };
}
