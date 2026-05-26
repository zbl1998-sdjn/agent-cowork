// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '../security/redaction.js';

const OMIT_KEYS = new Set(['fetchImpl', 'onContent', 'onReasoning', 'signal']);
const SECRET_KEY_RE = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)/i;

/**
 * @typedef {{ fingerprint?: string, status?: string, response?: unknown, [key: string]: unknown }} ModelRecord
 * @typedef {{ append(record: ModelRecord): ModelRecord, list(): ModelRecord[], findByFingerprint(fingerprint: string): ModelRecord | null }} ModelRecordStore
 * @typedef {(args?: Record<string, unknown>) => unknown | Promise<unknown>} ModelCall
 * @typedef {{ store?: ModelRecordStore, now?: () => string }} ModelRecorderOptions
 * @typedef {{ store?: ModelRecordStore }} ModelReplayerOptions
 */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function jsonClone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** @param {unknown} value @returns {unknown} */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record).sort()) {
    out[key] = stableValue(record[key]);
  }
  return out;
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

/** @param {unknown} value @param {string} [key] @returns {unknown} */
function sanitizeValue(value, key = '') {
  if (OMIT_KEYS.has(key)) return undefined;
  if (typeof value === 'function') return undefined;
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeValue(childValue, childKey);
    if (sanitized !== undefined) out[childKey] = sanitized;
  }
  return out;
}

/** @param {Record<string, unknown>} [args] @returns {Record<string, unknown>} */
export function sanitizeModelCallInput(args = {}) {
  return /** @type {Record<string, unknown>} */ (sanitizeValue(args) || {});
}

/** @param {Record<string, unknown>} [args] @returns {string} */
export function modelCallFingerprint(args = {}) {
  const request = sanitizeModelCallInput(args);
  return `sha256:${crypto.createHash('sha256').update(stableJson(request)).digest('hex')}`;
}

/** @param {ModelRecord[]} [initialRecords] @returns {ModelRecordStore} */
export function createMemoryModelRecordStore(initialRecords = []) {
  const records = initialRecords.map((record) => jsonClone(record));
  return {
    /** @param {ModelRecord} record */
    append(record) {
      const cloned = jsonClone(record);
      records.push(cloned);
      return jsonClone(cloned);
    },
    /** @returns {ModelRecord[]} */
    list() {
      return records.map((record) => jsonClone(record));
    },
    /** @param {string} fingerprint */
    findByFingerprint(fingerprint) {
      const found = records.find((record) => record.fingerprint === fingerprint && record.status === 'succeeded');
      return found ? jsonClone(found) : null;
    },
  };
}

/** @param {string} filePath @returns {ModelRecordStore & { filePath: string }} */
export function createJsonlModelRecordStore(filePath) {
  const recordPath = path.resolve(filePath);
  /** @returns {ModelRecord[]} */
  function readRecords() {
    let raw = '';
    try {
      raw = fs.readFileSync(recordPath, 'utf8');
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return {
    /** @param {ModelRecord} record */
    append(record) {
      const cloned = jsonClone(record);
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.appendFileSync(recordPath, `${JSON.stringify(cloned)}\n`, 'utf8');
      return jsonClone(cloned);
    },
    /** @returns {ModelRecord[]} */
    list() {
      return readRecords().map((record) => jsonClone(record));
    },
    /** @param {string} fingerprint */
    findByFingerprint(fingerprint) {
      const records = readRecords();
      const found = records.find((record) => record.fingerprint === fingerprint && record.status === 'succeeded');
      return found ? jsonClone(found) : null;
    },
    filePath: recordPath,
  };
}

/** @param {unknown} error @returns {{ name: string, code: unknown, message: string }} */
function errorSummary(error) {
  const err = /** @type {{ name?: string, code?: unknown, message?: string }} */ (error);
  return {
    name: err?.name || 'Error',
    code: err?.code || undefined,
    message: redactText(err?.message || String(error)) || '',
  };
}

/** @param {ModelRecorderOptions} [options] */
export function createModelRecorder({ store = createMemoryModelRecordStore(), now = () => new Date().toISOString() } = {}) {
  return {
    store,
    /** @param {ModelCall} modelCall */
    wrap(modelCall) {
      if (typeof modelCall !== 'function') {
        throw new TypeError('ModelRecorder.wrap requires a modelCall function');
      }
      /** @param {Record<string, unknown>} [args] */
      return async function recordedModelCall(args = {}) {
        const request = sanitizeModelCallInput(args);
        const fingerprint = modelCallFingerprint(args);
        const startedAt = now();
        try {
          const response = await modelCall(args);
          const record = {
            kind: 'model-call',
            status: 'succeeded',
            fingerprint,
            startedAt,
            finishedAt: now(),
            request,
            response: jsonClone(response),
          };
          store.append(record);
          return response;
        } catch (error) {
          store.append({
            kind: 'model-call',
            status: 'failed',
            fingerprint,
            startedAt,
            finishedAt: now(),
            request,
            error: errorSummary(error),
          });
          throw error;
        }
      };
    },
  };
}

/** @param {ModelReplayerOptions} [options] */
export function createModelReplayer({ store } = {}) {
  if (!store || typeof store.findByFingerprint !== 'function') {
    throw new TypeError('ModelReplayer requires a store with findByFingerprint');
  }
  return {
    wrap() {
      /** @param {Record<string, unknown>} [args] */
      return async function replayedModelCall(args = {}) {
        const fingerprint = modelCallFingerprint(args);
        const record = store.findByFingerprint(fingerprint);
        if (!record) {
          const error = /** @type {Error & { code: string, fingerprint: string }} */ (new Error('Model replay miss'));
          error.code = 'MODEL_REPLAY_MISS';
          error.fingerprint = fingerprint;
          throw error;
        }
        return jsonClone(record.response);
      };
    },
  };
}
