import crypto from 'node:crypto';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PREFIX = 'run';

function pickAlphabet(byte) {
  return ULID_ALPHABET[byte & 0x1f];
}

function timestampPart(ms) {
  let value = BigInt(ms);
  const base = BigInt(32);
  const out = new Array(10);
  for (let i = 9; i >= 0; i -= 1) {
    out[i] = ULID_ALPHABET[Number(value % base)];
    value /= base;
  }
  return out.join('');
}

export function createUlid(now = Date.now(), { randomBytes = crypto.randomBytes } = {}) {
  const rand = randomBytes(16);
  const randomPart = Array.from(rand, pickAlphabet).join('');
  return `${ID_PREFIX}_${timestampPart(now)}${randomPart}`;
}

function normaliseId(value, fallback) {
  const text = String(value || '').trim();
  if (!text) {
    return fallback;
  }
  return text.length > 96 ? text.slice(0, 96) : text;
}

export function normaliseTenantId(value) {
  return normaliseId(value, 'tenant_local');
}

export function normaliseUserId(value) {
  return normaliseId(value, 'user_local');
}

export function normaliseRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('runs-index: record must be an object');
  }
  const id = String(record.id || '').trim();
  if (!id) {
    throw new Error('runs-index: record.id is required');
  }
  return {
    id,
    tenantId: normaliseTenantId(record.tenantId),
    userId: normaliseUserId(record.userId),
    traceId: String(record.traceId || ''),
    type: String(record.type || ''),
    status: String(record.status || ''),
    mode: record.mode ? String(record.mode) : null,
    provider: record.provider ? String(record.provider) : null,
    recipeId: record.recipeId ? String(record.recipeId) : null,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
    promptPreview: typeof record.promptPreview === 'string' ? record.promptPreview.slice(0, 240) : null,
    error: record.error ? String(record.error).slice(0, 1024) : null,
    runPath: record.runPath ? String(record.runPath) : null,
    version: Number(record.version) || 1,
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}
