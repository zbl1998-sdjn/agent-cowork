// 运行索引·共用工具(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:文件/SQLite 两个运行索引后端共用的纯函数——ULID 生成、记录归一化、tenant/user 归一化。
// 依赖:node:crypto。导出:createUlid / normaliseRecord / normaliseTenantId / normaliseUserId。
import crypto from 'node:crypto';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PREFIX = 'run';

export type RandomBytes = (size: number) => ArrayLike<number>;
export type CreateUlidOptions = { randomBytes?: RandomBytes };
export type NormalisedRunRecord = {
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
  updatedAt: unknown;
};

function pickAlphabet(byte: number): string {
  return ULID_ALPHABET[byte & 0x1f] ?? '0';
}

function timestampPart(ms: number): string {
  let value = BigInt(ms);
  const base = BigInt(32);
  const out = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    out[i] = ULID_ALPHABET[Number(value % base)] ?? '0';
    value /= base;
  }
  return out.join('');
}

/**
 */
export function createUlid(now = Date.now(), { randomBytes = crypto.randomBytes }: CreateUlidOptions = {}): string {
  const rand = randomBytes(16);
  const randomPart = Array.from(rand, pickAlphabet).join('');
  return `${ID_PREFIX}_${timestampPart(now)}${randomPart}`;
}

function normaliseId(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  if (!text) {
    return fallback;
  }
  return text.length > 96 ? text.slice(0, 96) : text;
}

export function normaliseTenantId(value: unknown): string {
  return normaliseId(value, 'tenant_local');
}

export function normaliseUserId(value: unknown): string {
  return normaliseId(value, 'user_local');
}

export function normaliseRecord(record: unknown): NormalisedRunRecord {
  if (!record || typeof record !== 'object') {
    throw new Error('runs-index: record must be an object');
  }
  const input = record as Record<string, unknown>;
  const id = String(input.id || '').trim();
  if (!id) {
    throw new Error('runs-index: record.id is required');
  }
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
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
