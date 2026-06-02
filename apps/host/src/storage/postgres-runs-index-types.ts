// Postgres runs 索引类型契约(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:集中定义 Postgres runs 索引的类型——连接池/结果、run 记录输入与落盘形态、
//       查询/统计选项,以及异步索引接口 AsyncRunsIndex,供 records 与索引实现共享。
export type PgResult = { rows?: unknown[]; rowCount?: number | null };
export type PgPool = { query(text: string, params?: unknown[]): Promise<PgResult>; end?: () => Promise<unknown> };
export type RunRecordInput = {
  id?: unknown;
  tenantId?: unknown;
  userId?: unknown;
  traceId?: unknown;
  type?: unknown;
  status?: unknown;
  mode?: unknown;
  provider?: unknown;
  recipeId?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  durationMs?: unknown;
  promptPreview?: unknown;
  error?: unknown;
  runPath?: unknown;
  version?: unknown;
  updatedAt?: unknown;
};
export type RunRecord = {
  id: string;
  tenantId: string;
  userId: string;
  traceId: string;
  type: string;
  status: string;
  mode: string | null;
  provider: string | null;
  recipeId: string | null;
  startedAt: unknown;
  finishedAt: unknown;
  durationMs: number | null;
  promptPreview: string | null;
  error: string | null;
  runPath: string | null;
  version: number;
  updatedAt: string;
};
export type RunContext = { traceId?: unknown };
export type RunsGetOptions = { tenantId?: unknown };
export type RunsListOptions = {
  tenantId?: unknown;
  userId?: unknown;
  limit?: unknown;
  status?: unknown;
  type?: unknown;
  recipeId?: unknown;
};
export type RunsStatsOptions = { tenantId?: unknown };
export type RunsStats = { total: number; byStatus: Record<string, number>; byType: Record<string, number> };
export type PostgresRunsIndexOptions = {
  pool?: PgPool | null;
  connectionString?: string | null;
  table?: string;
  now?: () => Date;
};
export type AsyncRunsIndex = {
  upsert(record: RunRecordInput, context?: RunContext): Promise<RunRecord>;
  remove(id: string): Promise<boolean>;
  get(id: string, options?: RunsGetOptions): Promise<RunRecord | null>;
  list(options?: RunsListOptions): Promise<RunRecord[]>;
  size(): Promise<number>;
  stats(options?: RunsStatsOptions): Promise<RunsStats>;
  close?: () => Promise<void>;
};
