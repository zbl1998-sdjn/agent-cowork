// 模型调用录制(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把模型请求/响应「录制」落盘以便回放与评测(eval/replay)。落盘前剔除不可序列化键(fetchImpl/回调/signal)
//       并对密钥字段脱敏,绝不写入明文凭据。依赖:L0 redaction。导出:模型录制器工厂。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '../security/redaction.js';

const OMIT_KEYS = new Set(['fetchImpl', 'onContent', 'onReasoning', 'signal']);
const SECRET_KEY_RE = /(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)/i;

export type ModelRecord = {
  fingerprint?: string;
  status?: string;
  response?: unknown;
  [key: string]: unknown;
};
export type ModelRecordStore = {
  append(record: ModelRecord): ModelRecord;
  list(): ModelRecord[];
  findByFingerprint(fingerprint: string): ModelRecord | null;
};
export type ModelCall = (args?: Record<string, unknown>) => unknown | Promise<unknown>;
export type ModelRecorderOptions = { store?: ModelRecordStore; now?: () => string };
export type ModelReplayerOptions = { store?: ModelRecordStore };
export type ModelRecorder = {
  store: ModelRecordStore;
  wrap(modelCall: ModelCall): ModelCall;
};
export type ModelReplayer = {
  wrap(modelCall?: ModelCall): ModelCall;
};
type FileError = { code?: string };

function jsonClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    out[key] = stableValue(record[key]);
  }
  return out;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (OMIT_KEYS.has(key)) return undefined;
  if (typeof value === 'function') return undefined;
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeValue(childValue, childKey);
    if (sanitized !== undefined) out[childKey] = sanitized;
  }
  return out;
}

export function sanitizeModelCallInput(args: Record<string, unknown> = {}): Record<string, unknown> {
  return sanitizeValue(args) as Record<string, unknown> || {};
}

export function modelCallFingerprint(args: Record<string, unknown> = {}): string {
  const request = sanitizeModelCallInput(args);
  return `sha256:${crypto.createHash('sha256').update(stableJson(request)).digest('hex')}`;
}

export function createMemoryModelRecordStore(initialRecords: ModelRecord[] = []): ModelRecordStore {
  const records = initialRecords.map((record) => jsonClone(record));
  return {
    append(record: ModelRecord): ModelRecord {
      const cloned = jsonClone(record);
      records.push(cloned);
      return jsonClone(cloned);
    },
    list(): ModelRecord[] {
      return records.map((record) => jsonClone(record));
    },
    findByFingerprint(fingerprint: string): ModelRecord | null {
      const found = records.find((record) => record.fingerprint === fingerprint && record.status === 'succeeded');
      return found ? jsonClone(found) : null;
    },
  };
}

export function createJsonlModelRecordStore(filePath: string): ModelRecordStore & { filePath: string } {
  const recordPath = path.resolve(filePath);
  function readRecords(): ModelRecord[] {
    let raw = '';
    try {
      raw = fs.readFileSync(recordPath, 'utf8');
    } catch (error) {
      if ((error as FileError)?.code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ModelRecord);
  }
  return {
    append(record: ModelRecord): ModelRecord {
      const cloned = jsonClone(record);
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.appendFileSync(recordPath, `${JSON.stringify(cloned)}\n`, 'utf8');
      return jsonClone(cloned);
    },
    list(): ModelRecord[] {
      return readRecords().map((record) => jsonClone(record));
    },
    findByFingerprint(fingerprint: string): ModelRecord | null {
      const records = readRecords();
      const found = records.find((record) => record.fingerprint === fingerprint && record.status === 'succeeded');
      return found ? jsonClone(found) : null;
    },
    filePath: recordPath,
  };
}

function errorSummary(error: unknown): { name: string; code: unknown; message: string } {
  const err = error as { name?: string; code?: unknown; message?: string } | null | undefined;
  return {
    name: err?.name || 'Error',
    code: err?.code || undefined,
    message: redactText(err?.message || String(error)) || '',
  };
}

export function createModelRecorder({
  store = createMemoryModelRecordStore(),
  now = () => new Date().toISOString(),
}: ModelRecorderOptions = {}): ModelRecorder {
  return {
    store,
    wrap(modelCall: ModelCall): ModelCall {
      if (typeof modelCall !== 'function') {
        throw new TypeError('ModelRecorder.wrap requires a modelCall function');
      }
      return async function recordedModelCall(args: Record<string, unknown> = {}): Promise<unknown> {
        const request = sanitizeModelCallInput(args);
        const fingerprint = modelCallFingerprint(args);
        const startedAt = now();
        try {
          const response = await modelCall(args);
          const record: ModelRecord = {
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

export function createModelReplayer({ store }: ModelReplayerOptions = {}): ModelReplayer {
  if (!store || typeof store.findByFingerprint !== 'function') {
    throw new TypeError('ModelReplayer requires a store with findByFingerprint');
  }
  return {
    wrap(_modelCall?: ModelCall): ModelCall {
      return async function replayedModelCall(args: Record<string, unknown> = {}): Promise<unknown> {
        const fingerprint = modelCallFingerprint(args);
        const record = store.findByFingerprint(fingerprint);
        if (!record) {
          const error = new Error('Model replay miss') as Error & { code: string; fingerprint: string };
          error.code = 'MODEL_REPLAY_MISS';
          error.fingerprint = fingerprint;
          throw error;
        }
        return jsonClone(record.response);
      };
    },
  };
}
