import crypto from 'node:crypto';
import { redactText } from '../security/redaction.js';

const OMIT_KEYS = new Set(['fetchImpl', 'onContent', 'onReasoning', 'signal']);
const SECRET_KEY_RE = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)/i;

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableValue(value[key]);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sanitizeValue(value, key = '') {
  if (OMIT_KEYS.has(key)) return undefined;
  if (typeof value === 'function') return undefined;
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeValue(childValue, childKey);
    if (sanitized !== undefined) out[childKey] = sanitized;
  }
  return out;
}

export function sanitizeModelCallInput(args = {}) {
  return sanitizeValue(args) || {};
}

export function modelCallFingerprint(args = {}) {
  const request = sanitizeModelCallInput(args);
  return `sha256:${crypto.createHash('sha256').update(stableJson(request)).digest('hex')}`;
}

export function createMemoryModelRecordStore(initialRecords = []) {
  const records = initialRecords.map((record) => jsonClone(record));
  return {
    append(record) {
      const cloned = jsonClone(record);
      records.push(cloned);
      return jsonClone(cloned);
    },
    list() {
      return records.map((record) => jsonClone(record));
    },
    findByFingerprint(fingerprint) {
      const found = records.find((record) => record.fingerprint === fingerprint && record.status === 'succeeded');
      return found ? jsonClone(found) : null;
    },
  };
}

function errorSummary(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || undefined,
    message: redactText(error?.message || String(error)),
  };
}

export function createModelRecorder({ store = createMemoryModelRecordStore(), now = () => new Date().toISOString() } = {}) {
  return {
    store,
    wrap(modelCall) {
      if (typeof modelCall !== 'function') {
        throw new TypeError('ModelRecorder.wrap requires a modelCall function');
      }
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

export function createModelReplayer({ store } = {}) {
  if (!store || typeof store.findByFingerprint !== 'function') {
    throw new TypeError('ModelReplayer requires a store with findByFingerprint');
  }
  return {
    wrap() {
      return async function replayedModelCall(args = {}) {
        const fingerprint = modelCallFingerprint(args);
        const record = store.findByFingerprint(fingerprint);
        if (!record) {
          const error = new Error('Model replay miss');
          error.code = 'MODEL_REPLAY_MISS';
          error.fingerprint = fingerprint;
          throw error;
        }
        return jsonClone(record.response);
      };
    },
  };
}
