// 运行记录存储(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:生成 runId 并把每次「运行」(agent/recipe/sandbox)的完整记录落盘为 JSON——含输入、状态、
//       结果、嵌入的事件时间线。写入前补充归因(租户/用户/trace)与指标(耗时/用量)。是可观测/可回放的底座。
// 依赖:node:crypto/fs/path + 同层 run-attribution / run-metrics。导出:createRunId / writeRunRecord 等。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withRunAttribution } from './run-attribution.js';
import { withRunMetrics } from './run-metrics.js';
import { AtRestKeyError, openAtRest, sealAtRest } from '../security/at-rest.js';
import {
  ManagedStateFilesystem,
  ManagedStatePathError,
} from '../security/managed-state-filesystem.js';
import {
  ensureRunOwnerClaim,
  normalizeRunOwner,
  sameRunOwner,
  type RunOwner,
} from '../util/run-owner.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

// run 记录含完整对话正文+模型输出,是最高敏感落盘面之一。加密密钥箱与其它 store 共享
// 在工作区的 .AgentCowork/security 下(runStoreRoot 通常是 .AgentCowork/runs)。
function runSecurityDir(runStoreRoot: string): string {
  return path.join(path.dirname(runStoreRoot), 'security');
}

export type RunRecord = {
  id: string;
  type?: unknown;
  status?: unknown;
  provider?: unknown;
  mode?: unknown;
  recipeId?: unknown;
  tenantId?: unknown;
  userId?: unknown;
  traceId?: unknown;
  context?: Record<string, unknown>;
  startedAt?: unknown;
  finishedAt?: unknown;
  durationMs?: unknown;
  input?: { prompt?: unknown; [key: string]: unknown };
  error?: { message?: unknown };
  [key: string]: unknown;
};

export type RunSummary = {
  id: string;
  type: unknown;
  status: unknown;
  mode: unknown;
  provider: unknown;
  recipeId: unknown;
  tenantId: unknown;
  userId: unknown;
  traceId: unknown;
  context: Record<string, unknown> | undefined;
  startedAt: unknown;
  finishedAt: unknown;
  durationMs: unknown;
  prompt: unknown;
  error: unknown;
  path: string;
};

export type RunIdOptions = {
  randomHex?: (length: number) => string;
};

type ListRunRecordsOptions = {
  limit?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPersistedRunRecord(value: unknown, expectedId: string): value is RunRecord {
  if (!isRecord(value) || value.id !== expectedId) return false;
  const attribution = value.attribution;
  const metrics = value.metrics;
  if (isRecord(attribution) && attribution.schemaVersion === 1
    && isRecord(metrics) && metrics.schemaVersion === 1) return true;
  return (isRecord(value.input))
    || (typeof value.status === 'string')
    || (typeof value.startedAt === 'string' || typeof value.startedAt === 'number')
    || Array.isArray(value.events)
    || Object.hasOwn(value, 'result');
}

export function createRunId(now: Date = new Date(), { randomHex }: RunIdOptions = {}): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = typeof randomHex === 'function'
    ? randomHex(8)
    : crypto.randomBytes(16).toString('hex');
  return `run_${timestamp}_${suffix}`;
}

export function getRunPath(runStoreRoot: string, runId: string): string {
  if (!RUN_ID_RE.test(runId || '')) {
    throw new Error('Invalid run id');
  }
  return path.join(runStoreRoot, `${runId}.json`);
}

export function runRecordOwner(record: RunRecord): RunOwner {
  const context = record.context && typeof record.context === 'object' && !Array.isArray(record.context)
    ? record.context
    : undefined;
  if (context && (Object.hasOwn(context, 'tenantId') || Object.hasOwn(context, 'userId'))) {
    return normalizeRunOwner(context, { label: 'Run record owner' });
  }
  if (Object.hasOwn(record, 'tenantId') || Object.hasOwn(record, 'userId')) {
    return normalizeRunOwner(record, { label: 'Run record owner' });
  }
  return normalizeRunOwner(undefined, {
    allowLocalDefault: true,
    label: 'Run record owner',
  });
}

function readRunRecordFrom(
  filesystem: ManagedStateFilesystem,
  runStoreRoot: string,
  runId: string,
): RunRecord | null {
  const raw = filesystem.readFile(getRunPath(runStoreRoot, runId));
  if (raw === null) return null;
  const opened = openAtRest(raw, runSecurityDir(runStoreRoot));
  if (opened === null) return null;
  const parsed: unknown = JSON.parse(opened);
  if (!isPersistedRunRecord(parsed, runId)) {
    throw new Error('Run record is corrupt or has mismatched id');
  }
  return parsed;
}

export function writeRunRecord(runStoreRoot: string, record: RunRecord): string {
  if (!record || typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error('Run record id is required');
  }
  const filesystem = new ManagedStateFilesystem(runStoreRoot, { label: 'Run store' });
  const enriched = withRunMetrics(withRunAttribution(record)) as RunRecord;
  const runPath = getRunPath(runStoreRoot, enriched.id);
  const owner = runRecordOwner(enriched);
  if (filesystem.fileExists(runPath)) {
    let existing: RunRecord | null;
    try {
      existing = readRunRecordFrom(filesystem, runStoreRoot, enriched.id);
    } catch (error) {
      if (error instanceof AtRestKeyError || error instanceof ManagedStatePathError) throw error;
      throw new Error('Run record owner could not be verified');
    }
    if (!existing) throw new Error('Run record owner could not be verified');
    if (!sameRunOwner(runRecordOwner(existing), owner)) {
      throw new Error('Run record owner mismatch');
    }
  }
  const claimPath = path.join(runStoreRoot, '.owners', `${enriched.id}.json`);
  ensureRunOwnerClaim({
    claimPath,
    owner,
    label: 'Run record',
    beforeFilesystemMutation: filesystem.guardMutation,
    boundary: filesystem.boundary,
  });
  filesystem.guardMutation(claimPath);
  const persisted = sealAtRest(`${JSON.stringify(enriched, null, 2)}\n`, runSecurityDir(runStoreRoot));
  filesystem.writeFile(runPath, persisted);
  return runPath;
}

export function readRunRecord(runStoreRoot: string, runId: string): RunRecord | null {
  getRunPath(runStoreRoot, runId);
  if (!fs.existsSync(runStoreRoot)) return null;
  const filesystem = new ManagedStateFilesystem(runStoreRoot, {
    create: false,
    label: 'Run store',
  });
  return readRunRecordFrom(filesystem, runStoreRoot, runId);
}

export function listRunRecords(
  runStoreRoot: string,
  { limit = 20 }: ListRunRecordsOptions = {},
): RunSummary[] {
  if (!fs.existsSync(runStoreRoot)) {
    return [];
  }
  const filesystem = new ManagedStateFilesystem(runStoreRoot, {
    create: false,
    label: 'Run store',
  });
  const records: RunSummary[] = [];
  for (const fullPath of filesystem.listFiles(runStoreRoot, (name) => name.endsWith('.json'))) {
    try {
      const raw = filesystem.readFile(fullPath);
      if (raw === null) continue;
      const opened = openAtRest(raw, runSecurityDir(runStoreRoot));
      if (opened === null) continue; // 开不了的记录跳过,列表尽力可用
      const expectedId = path.basename(fullPath, '.json');
      const parsed: unknown = JSON.parse(opened);
      if (!isPersistedRunRecord(parsed, expectedId)) continue;
      const record = parsed;
      const owner = runRecordOwner(record);
      records.push({
        id: record.id,
        type: record.type,
        status: record.status,
        provider: record.provider,
        mode: record.mode,
        recipeId: record.recipeId,
        tenantId: owner.tenantId,
        userId: owner.userId,
        traceId: record.context?.traceId || record.traceId,
        context: record.context,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        prompt: record.input?.prompt,
        error: record.error?.message,
        path: fullPath,
      });
    } catch (error) {
      if (error instanceof AtRestKeyError || error instanceof ManagedStatePathError) throw error;
      // 单条 run 记录损坏时跳过,列表接口保持尽力可用。
    }
  }
  return records
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))
    .slice(0, limit);
}
