// runs 索引记录归一与解析(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:为 Postgres runs 索引做记录层处理——归一化单条 run 记录(必填校验、租户/用户严格校验、
//       字段截断、默认版本)、校验表名防注入、从 record_json 列还原 RunRecord。
// 依赖:L1 storage(postgres-runs-index-types 的类型契约)。
// 导出:normaliseTenantId, normaliseUserId, safePgIdentifier, normaliseRecord, parseRecord。
import type { RunRecord, RunRecordInput } from './postgres-runs-index-types.js';
import {
  canonicalIdentityPart,
  canonicalRequiredIdentityScope,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';

type RunsIndexRow = { record_json?: unknown };

function requireIdentityPart(value: unknown, label: string): string {
  const canonical = canonicalIdentityPart(value);
  if (!canonical) throw new Error(`${label}: canonical identity part is required`);
  return canonical;
}

export const normaliseTenantId = (v: unknown): string => requireIdentityPart(v, 'runs-index tenantId');
export const normaliseUserId = (v: unknown): string => requireIdentityPart(v, 'runs-index userId');

/** 校验表名合法(表名拼进 SQL 不能参数化,需防注入)。 */
export function safePgIdentifier(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresRunsIndex: invalid table name');
  }
  return text;
}

/** 归一一条 run 记录:必填 id 校验、租户/用户严格校验、字段截断与默认版本。 */
export function normaliseRecord(record: unknown): RunRecord {
  if (!record || typeof record !== 'object') throw new Error('runs-index: record must be an object');
  const input = record as RunRecordInput;
  const id = String(input.id || '').trim();
  if (!id) throw new Error('runs-index: record.id is required');
  const owner = requireIdentityScopeFrom(input, { label: 'runs-index record identity' });
  return {
    id,
    tenantId: owner.tenantId,
    userId: owner.userId,
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
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as RunRecord;
  if (!canonicalRequiredIdentityScope(record.tenantId, record.userId)) return null;
  return record;
}
