// 运行索引(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:为「运行历史」提供可查询索引的统一入口与后端选择(文件 / SQLite,同一接口、端口与适配器)。
//       供历史列表/检索使用,避免逐条读 run 记录文件。
// 依赖:同层 runs-index-file / runs-index-sqlite / runs-index-utils。导出:RunsIndex / SqliteRunsIndex / createUlid。
import { RunsIndex } from './runs-index-file.js';
import { SqliteRunsIndex } from './runs-index-sqlite.js';
import { omitUndefined } from '../util/object.js';

export { RunsIndex } from './runs-index-file.js';
export { SqliteRunsIndex } from './runs-index-sqlite.js';
export { createUlid } from './runs-index-utils.js';

export type SqliteStatement = {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes?: number };
  all(...params: unknown[]): unknown[];
};
export type SqliteDatabase = { exec(sql: string): unknown; prepare(sql: string): SqliteStatement };
export type CreateRunsIndexOptions = {
  backend?: string;
  indexRoot?: string;
  dbPath?: string;
  db?: SqliteDatabase | null;
  now?: () => Date;
};
export type RunIndexContext = { tenantId?: unknown; userId?: unknown; traceId?: unknown };
type RunInput = { prompt?: unknown };
type RunContext = { tenantId?: unknown; userId?: unknown; traceId?: unknown };
type RunError = { message?: unknown };
type RunRecordInput = {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  mode?: unknown;
  provider?: unknown;
  recipeId?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  durationMs?: unknown;
  input?: RunInput;
  context?: RunContext;
  error?: RunError;
  runPath?: unknown;
};
export type RunIndexSummary = {
  id: unknown;
  tenantId: unknown;
  userId: unknown;
  traceId: unknown;
  type: unknown;
  status: unknown;
  mode: unknown;
  provider: unknown;
  recipeId: unknown;
  startedAt: unknown;
  finishedAt: unknown;
  durationMs: unknown;
  promptPreview: string;
  error: unknown;
  runPath: unknown;
};

export function createRunsIndex({ backend = 'file', indexRoot, dbPath, db, now }: CreateRunsIndexOptions = {}) {
  return backend === 'sqlite'
    ? new SqliteRunsIndex(omitUndefined({ dbPath, db, now }))
    : new RunsIndex(omitUndefined({ indexRoot, now }));
}

export function summariseRunForIndex(runRecord: unknown, context: RunIndexContext = {}): RunIndexSummary {
  if (!runRecord || typeof runRecord !== 'object') throw new Error('summariseRunForIndex: runRecord required');
  const record = runRecord as RunRecordInput;
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
