import { RunsIndex } from './runs-index-file.js';
import { SqliteRunsIndex } from './runs-index-sqlite.js';

export { RunsIndex } from './runs-index-file.js';
export { SqliteRunsIndex } from './runs-index-sqlite.js';
export { createUlid } from './runs-index-utils.js';

export function createRunsIndex({ backend = 'file', indexRoot, dbPath, db, now } = {}) {
  return backend === 'sqlite' ? new SqliteRunsIndex({ dbPath, db, now }) : new RunsIndex({ indexRoot, now });
}

export function summariseRunForIndex(runRecord, context = {}) {
  if (!runRecord || typeof runRecord !== 'object') throw new Error('summariseRunForIndex: runRecord required');
  const promptText = typeof runRecord.input?.prompt === 'string' ? runRecord.input.prompt : '';
  return {
    id: runRecord.id,
    tenantId: context.tenantId || runRecord.context?.tenantId,
    userId: context.userId || runRecord.context?.userId,
    traceId: context.traceId || runRecord.context?.traceId,
    type: runRecord.type,
    status: runRecord.status,
    mode: runRecord.mode,
    provider: runRecord.provider,
    recipeId: runRecord.recipeId,
    startedAt: runRecord.startedAt,
    finishedAt: runRecord.finishedAt,
    durationMs: runRecord.durationMs,
    promptPreview: promptText.slice(0, 240),
    error: runRecord.error?.message,
    runPath: runRecord.runPath || null,
  };
}
