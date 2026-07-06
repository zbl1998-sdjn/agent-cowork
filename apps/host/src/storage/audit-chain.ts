// Tamper-evident audit hash chain helpers.
// ---------------------------------------------------------------------------
// Responsibilities: create deterministic per-line hashes for JSONL audit
// records and verify that a chain has not been modified after writing.
import crypto from 'node:crypto';
import fs from 'node:fs';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

export function readLastAuditHash(filePath: string): string | null {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  for (const line of text.trimEnd().split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && typeof parsed.event_hash === 'string' && parsed.event_hash.length > 0) {
        return parsed.event_hash;
      }
    } catch {
      return null;
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

