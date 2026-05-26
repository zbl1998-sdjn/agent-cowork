// @ts-check
import crypto from 'node:crypto';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PREFIX = 'run';

/**
 * @typedef {(size: number) => ArrayLike<number>} RandomBytes
 * @typedef {{ randomBytes?: RandomBytes }} CreateUlidOptions
 * @typedef {{
 *   id: string,
 *   tenantId: string,
 *   userId: string,
 *   traceId: string,
 *   type: string,
 *   status: string,
 *   mode: string | null,
 *   provider: string | null,
 *   recipeId: string | null,
 *   startedAt: unknown,
 *   finishedAt: unknown,
 *   durationMs: number | null,
 *   promptPreview: string | null,
 *   error: string | null,
 *   runPath: string | null,
 *   version: number,
 *   updatedAt: unknown
 * }} NormalisedRunRecord
 */

/** @param {number} byte @returns {string} */
function pickAlphabet(byte) {
  return ULID_ALPHABET[byte & 0x1f];
}

/** @param {number} ms @returns {string} */
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

/**
 * @param {number} [now]
 * @param {CreateUlidOptions} [options]
 * @returns {string}
 */
export function createUlid(now = Date.now(), { randomBytes = crypto.randomBytes } = {}) {
  const rand = randomBytes(16);
  const randomPart = Array.from(rand, pickAlphabet).join('');
  return `${ID_PREFIX}_${timestampPart(now)}${randomPart}`;
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function normaliseId(value, fallback) {
  const text = String(value || '').trim();
  if (!text) {
    return fallback;
  }
  return text.length > 96 ? text.slice(0, 96) : text;
}

/** @param {unknown} value @returns {string} */
export function normaliseTenantId(value) {
  return normaliseId(value, 'tenant_local');
}

/** @param {unknown} value @returns {string} */
export function normaliseUserId(value) {
  return normaliseId(value, 'user_local');
}

/** @param {unknown} record @returns {NormalisedRunRecord} */
export function normaliseRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('runs-index: record must be an object');
  }
  const input = /** @type {Record<string, unknown>} */ (record);
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
