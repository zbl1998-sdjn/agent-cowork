// Strict JSONL adapter for the file runs index (host · L1 storage).
import { canonicalRequiredIdentityScope } from '../security/identity-scope.js';
import {
  appendValidatedJsonl,
  readValidatedJsonl,
  type JsonlManagedAccess,
} from './jsonl-file.js';
import type { NormalisedRunRecord } from './runs-index-utils.js';

export type RunIndexRecord = NormalisedRunRecord & Record<string, unknown>;
export type RunIndexEvent = {
  id?: unknown;
  op?: string;
  record?: RunIndexRecord;
  tenantId?: string;
  userId?: string;
  traceId?: unknown;
  ts?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRunRecord(value: unknown): value is RunIndexRecord {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.tenantId === 'string'
    && typeof value.userId === 'string'
    && typeof value.type === 'string'
    && typeof value.status === 'string'
    && typeof value.version === 'number'
    && Number.isFinite(value.version)
    && value.version > 0;
}

function validateRunIndexEvent(value: unknown): RunIndexEvent {
  if (!isRecord(value)
    || (value.op !== 'upsert' && value.op !== 'delete')
    || typeof value.id !== 'string'
    || !value.id
    || typeof value.tenantId !== 'string'
    || typeof value.userId !== 'string') {
    throw new Error('runs-index event has an invalid root or operation');
  }
  const eventOwner = canonicalRequiredIdentityScope(value.tenantId, value.userId);
  if (!eventOwner) {
    throw new Error('runs-index event has an invalid owner');
  }
  if (value.op === 'upsert' && !validateRunRecord(value.record)) {
    throw new Error('runs-index event has an invalid record');
  }
  if (value.op === 'upsert') {
    const record = value.record as RunIndexRecord;
    const recordOwner = canonicalRequiredIdentityScope(record.tenantId, record.userId);
    if (record.id !== value.id
      || !recordOwner
      || recordOwner.tenantId !== eventOwner.tenantId
      || recordOwner.userId !== eventOwner.userId) {
      throw new Error('runs-index event record does not match its id or owner');
    }
  }
  if (value.op === 'delete' && value.record !== undefined) {
    throw new Error('runs-index delete event must not contain a record');
  }
  return value as RunIndexEvent;
}

export function readRunIndexEvents(
  filePath: string,
  access?: JsonlManagedAccess,
): RunIndexEvent[] {
  return readValidatedJsonl(filePath, 'runs-index event', validateRunIndexEvent, access);
}

export function appendRunIndexEvent(
  filePath: string,
  event: RunIndexEvent,
  access?: JsonlManagedAccess,
): void {
  appendValidatedJsonl(filePath, event, 'runs-index event', validateRunIndexEvent, access);
}
