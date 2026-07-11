// Schedule record construction and validation (host · L2 · runtime).
import { describeCron, nextFireAt, parseCron } from './cron.js';
import { createUlid } from './runs-index.js';
import { requireIdentityScopeFrom } from '../security/identity-scope.js';
import {
  SCHEDULE_ATTEMPT_HISTORY_LIMIT,
  type ScheduleAttempt,
  type ScheduleRecord,
} from './scheduler-store-types.js';

export type ScheduleCreateInput = {
  name?: unknown;
  cron?: string | null;
  fireAt?: string | null;
  payload?: unknown;
  tenantId?: unknown;
  userId?: unknown;
  traceId?: unknown;
  idempotencyKey?: unknown;
};

const SCHEDULE_ATTEMPT_KEYS = [
  'attemptId',
  'error',
  'finishedAt',
  'runId',
  'startedAt',
  'status',
  'trigger',
] as const;
const SCHEDULE_ATTEMPT_ID_RE = /^attempt_[A-Za-z0-9_-]{1,88}$/;
const SCHEDULE_RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function exactAttemptRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'));
  return keys.length === SCHEDULE_ATTEMPT_KEYS.length
    && keys.every((key, index) => key === SCHEDULE_ATTEMPT_KEYS[index])
    ? record
    : null;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString() === value ? value : null;
}

export function decodeScheduleAttempt(value: unknown): ScheduleAttempt | null {
  const fields = exactAttemptRecord(value);
  if (!fields || typeof fields.attemptId !== 'string' || !SCHEDULE_ATTEMPT_ID_RE.test(fields.attemptId)) {
    return null;
  }
  const startedAt = canonicalIso(fields.startedAt);
  const finishedAt = canonicalIso(fields.finishedAt);
  if (!startedAt || !finishedAt || Date.parse(finishedAt) < Date.parse(startedAt)) return null;
  if (fields.status !== 'succeeded' && fields.status !== 'failed') return null;
  if (fields.trigger !== 'scheduled') return null;
  let runId: string | null;
  if (fields.runId === null) {
    runId = null;
  } else if (typeof fields.runId === 'string' && SCHEDULE_RUN_ID_RE.test(fields.runId)) {
    runId = fields.runId;
  } else {
    return null;
  }
  let error: string | null;
  if (fields.error === null) {
    error = null;
  } else if (typeof fields.error === 'string' && fields.error.length > 0 && fields.error.length <= 1024) {
    error = fields.error;
  } else {
    return null;
  }
  if (fields.status === 'succeeded' && error !== null) return null;
  if (fields.status === 'failed' && (runId !== null || error === null)) return null;
  return {
    attemptId: fields.attemptId,
    startedAt,
    finishedAt,
    status: fields.status,
    runId,
    error,
    trigger: fields.trigger,
  };
}

export function normaliseScheduleRecordAttempts(record: ScheduleRecord): ScheduleRecord | null {
  if (record.attempts === undefined) return { ...record, attempts: [] };
  if (!Array.isArray(record.attempts)) return null;
  const attempts: ScheduleAttempt[] = [];
  const ids = new Set<string>();
  for (const value of record.attempts as unknown[]) {
    const attempt = decodeScheduleAttempt(value);
    if (!attempt || ids.has(attempt.attemptId)) return null;
    ids.add(attempt.attemptId);
    attempts.push(attempt);
  }
  return { ...record, attempts: attempts.slice(-SCHEDULE_ATTEMPT_HISTORY_LIMIT) };
}

export function createScheduleAttempt(input: Omit<ScheduleAttempt, 'attemptId'>): ScheduleAttempt {
  const attempt = {
    attemptId: createUlid().replace(/^run_/, 'attempt_'),
    ...input,
  };
  const decoded = decodeScheduleAttempt(attempt);
  if (!decoded) throw new Error('Scheduler: invalid schedule attempt');
  return decoded;
}

export function appendScheduleAttempt(record: ScheduleRecord, attempt: ScheduleAttempt): ScheduleAttempt[] {
  const previous = Array.isArray(record.attempts) ? record.attempts : [];
  return [...previous, attempt].slice(-SCHEDULE_ATTEMPT_HISTORY_LIMIT);
}

function isPositiveFutureIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

export function createSchedulerRecord(input: ScheduleCreateInput, now: Date): ScheduleRecord {
  const owner = requireIdentityScopeFrom(input, { label: 'schedule identity' });
  const { name, cron, fireAt, payload = {}, traceId, idempotencyKey } = input;
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Scheduler: name is required');
  }
  if (!cron && !fireAt) throw new Error('Scheduler: cron or fireAt is required');
  if (cron) parseCron(cron);
  if (fireAt && !isPositiveFutureIso(fireAt)) {
    throw new Error('Scheduler: fireAt must be a future ISO timestamp');
  }
  const next = fireAt ? new Date(fireAt) : nextFireAt(cron as string, now);
  return {
    id: createUlid().replace(/^run_/, 'sched_'),
    version: 1,
    name: name.trim().slice(0, 200),
    kind: fireAt ? 'one-shot' : 'cron',
    cron: cron || null,
    cronHuman: cron ? describeCron(cron) : null,
    fireAt: fireAt || null,
    payload,
    ...owner,
    traceId: traceId ? String(traceId).slice(0, 96) : null,
    idempotencyKey: idempotencyKey ? String(idempotencyKey).slice(0, 96) : null,
    status: 'pending',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextFireAt: next.toISOString(),
    lastFiredAt: null,
    lastRunId: null,
    lastError: null,
    runs: 0,
    attempts: [],
  };
}
