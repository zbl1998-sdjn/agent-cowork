// Schedule store contracts shared by adapters and pure helpers (host · L2 · runtime).
import type { SqliteDatabase } from '../storage/sqlite.js';

export const SCHEDULE_ATTEMPT_HISTORY_LIMIT = 20;

export type ScheduleAttempt = {
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  status: 'succeeded' | 'failed';
  runId: string | null;
  error: string | null;
  trigger: 'scheduled';
};

export type ScheduleRecord = {
  id: string;
  tenantId: string;
  userId?: string;
  traceId?: string | null;
  name: string;
  kind: string;
  status: string;
  cron?: string | null;
  cronHuman?: string | null;
  fireAt?: string | null;
  nextFireAt?: string | null;
  lastFiredAt?: string | null;
  lastRunId?: string | null;
  lastError?: string | null;
  idempotencyKey?: string | null;
  payload?: unknown;
  version?: number;
  runs?: number;
  createdAt?: string;
  updatedAt?: string;
  attempts?: ScheduleAttempt[];
  [key: string]: unknown;
};

export type FileScheduleStoreOptions = { storeDir?: string };
export type SqliteScheduleStoreOptions = { dbPath?: string; db?: SqliteDatabase | null };
export type CreateScheduleStoreOptions = {
  backend?: string;
  storeDir?: string;
  dbPath?: string;
  db?: SqliteDatabase | null;
};
export type ScheduleListOptions = { tenantId?: unknown; userId?: unknown };
