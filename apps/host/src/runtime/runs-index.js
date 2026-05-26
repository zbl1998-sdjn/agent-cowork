// @ts-check
import { RunsIndex } from './runs-index-file.js';
import { SqliteRunsIndex } from './runs-index-sqlite.js';

export { RunsIndex } from './runs-index-file.js';
export { SqliteRunsIndex } from './runs-index-sqlite.js';
export { createUlid } from './runs-index-utils.js';

/**
 * @typedef {{ get(...params: unknown[]): unknown, run(...params: unknown[]): { changes?: number }, all(...params: unknown[]): unknown[] }} SqliteStatement
 * @typedef {{ prepare(sql: string): SqliteStatement }} SqliteDatabase
 * @typedef {{ backend?: string, indexRoot?: string, dbPath?: string, db?: SqliteDatabase | null, now?: () => Date }} CreateRunsIndexOptions
 * @typedef {{ tenantId?: unknown, userId?: unknown, traceId?: unknown }} RunIndexContext
 * @typedef {{ prompt?: unknown }} RunInput
 * @typedef {{ tenantId?: unknown, userId?: unknown, traceId?: unknown }} RunContext
 * @typedef {{ message?: unknown }} RunError
 * @typedef {{
 *   id?: unknown,
 *   type?: unknown,
 *   status?: unknown,
 *   mode?: unknown,
 *   provider?: unknown,
 *   recipeId?: unknown,
 *   startedAt?: unknown,
 *   finishedAt?: unknown,
 *   durationMs?: unknown,
 *   input?: RunInput,
 *   context?: RunContext,
 *   error?: RunError,
 *   runPath?: unknown
 * }} RunRecordInput
 */

/** @param {CreateRunsIndexOptions} [options] */
export function createRunsIndex({ backend = 'file', indexRoot, dbPath, db, now } = {}) {
  return backend === 'sqlite' ? new SqliteRunsIndex({ dbPath, db, now }) : new RunsIndex({ indexRoot, now });
}

/**
 * @param {unknown} runRecord
 * @param {RunIndexContext} [context]
 */
export function summariseRunForIndex(runRecord, context = {}) {
  if (!runRecord || typeof runRecord !== 'object') throw new Error('summariseRunForIndex: runRecord required');
  const record = /** @type {RunRecordInput} */ (runRecord);
  const promptText = typeof record.input?.prompt === 'string' ? record.input.prompt : '';
  return {
    id: record.id,
    tenantId: context.tenantId || record.context?.tenantId,
    userId: context.userId || record.context?.userId,
    traceId: context.traceId || record.context?.traceId,
    type: record.type,
    status: record.status,
    mode: record.mode,
    provider: record.provider,
    recipeId: record.recipeId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    promptPreview: promptText.slice(0, 240),
    error: record.error?.message,
    runPath: record.runPath || null,
  };
}
