// Run route parsing and owner visibility helpers (host · L3 · routes).
import { decodePathSegment } from '../http/request-utils.js';
import {
  listRunRecords,
  runRecordOwner,
  type RunRecord,
  type RunSummary,
} from '../runtime/run-store.js';
import { taskFromRun, type RunSummary as PresenterRunSummary, type TaskSummary } from '../runtime/task-presenter.js';
import type { IdentityScope } from '../security/identity-scope.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;
type VisibleRunRecord = RunRecord | RunSummary;

export function recordVisibleToContext(
  record: VisibleRunRecord | null | undefined,
  owner: IdentityScope,
): boolean {
  if (!record) return false;
  try {
    const recordOwner = runRecordOwner(record as RunRecord);
    return recordOwner.tenantId === owner.tenantId && recordOwner.userId === owner.userId;
  } catch (error) {
    void error;
    return false;
  }
}

export function visibleRunRecords(
  runStoreRoot: string,
  owner: IdentityScope,
  limit: number,
): RunSummary[] {
  return listRunRecords(runStoreRoot, { limit: Number.MAX_SAFE_INTEGER })
    .filter((record) => recordVisibleToContext(record, owner))
    .slice(0, limit);
}

export function parseRunId(pathname: string, prefix: string, suffix = ''): string | null {
  const encoded = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  const runId = decodePathSegment(encoded);
  return runId && RUN_ID_RE.test(runId) ? runId : null;
}

export function presentRunTask(run: RunSummary): TaskSummary {
  return taskFromRun(run as unknown as PresenterRunSummary);
}
