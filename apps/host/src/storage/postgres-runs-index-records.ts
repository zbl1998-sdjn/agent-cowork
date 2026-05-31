import type { RunRecord, RunRecordInput } from './postgres-runs-index-types.js';

type RunsIndexRow = { record_json?: unknown };

function clampId(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.length > 96 ? text.slice(0, 96) : text;
}

export const normaliseTenantId = (v: unknown): string => clampId(v, 'tenant_local');
export const normaliseUserId = (v: unknown): string => clampId(v, 'user_local');

/** 校验表名合法(表名拼进 SQL 不能参数化,需防注入)。 */
export function safePgIdentifier(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresRunsIndex: invalid table name');
  }
  return text;
}

/** 归一一条 run 记录:必填 id 校验、租户/用户回落、字段截断与默认版本。 */
export function normaliseRecord(record: unknown): RunRecord {
  if (!record || typeof record !== 'object') throw new Error('runs-index: record must be an object');
  const input = record as RunRecordInput;
  const id = String(input.id || '').trim();
  if (!id) throw new Error('runs-index: record.id is required');
  return {
    id,
    tenantId: normaliseTenantId(input.tenantId),
    userId: normaliseUserId(input.userId),
    traceId: String(input.traceId || ''),
    type: String(input.type || ''),
    status: String(input.status || ''),
    mode: input.mode ? String(input.mode) : null,
    provider: input.provider ? String(input.provider) : null,
    recipeId: input.recipeId ? String(input.recipeId) : null,
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : null,
    promptPreview: typeof input.promptPreview === 'string' ? input.promptPreview.slice(0, 240) : null,
    error: input.error ? String(input.error).slice(0, 1024) : null,
    runPath: input.runPath ? String(input.runPath) : null,
    version: Number(input.version) || 1,
    updatedAt: String(input.updatedAt || new Date().toISOString()),
  };
}

/** 从行的 record_json 列还原 RunRecord(字符串则 parse,兼容 jsonb 直返)。 */
export function parseRecord(row: unknown): RunRecord | null {
  if (!row) return null;
  const raw = (row as RunsIndexRow).record_json;
  return typeof raw === 'string' ? JSON.parse(raw) as RunRecord : raw as RunRecord | null;
}
