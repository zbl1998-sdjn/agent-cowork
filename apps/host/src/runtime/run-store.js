import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

export function createRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `run_${timestamp}_${suffix}`;
}

export function getRunPath(runStoreRoot, runId) {
  if (!RUN_ID_RE.test(runId || '')) {
    throw new Error('Invalid run id');
  }
  return path.join(runStoreRoot, `${runId}.json`);
}

export function writeRunRecord(runStoreRoot, record) {
  if (!record || typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error('Run record id is required');
  }
  fs.mkdirSync(runStoreRoot, { recursive: true });
  const runPath = getRunPath(runStoreRoot, record.id);
  fs.writeFileSync(runPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return runPath;
}

export function readRunRecord(runStoreRoot, runId) {
  const runPath = getRunPath(runStoreRoot, runId);
  if (!fs.existsSync(runPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(runPath, 'utf8'));
}

export function listRunRecords(runStoreRoot, { limit = 20 } = {}) {
  if (!fs.existsSync(runStoreRoot)) {
    return [];
  }
  return fs
    .readdirSync(runStoreRoot)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fullPath = path.join(runStoreRoot, name);
      try {
        const record = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        return {
          id: record.id,
          type: record.type,
          status: record.status,
          provider: record.provider,
          mode: record.mode,
          recipeId: record.recipeId,
          tenantId: record.context?.tenantId || record.tenantId || 'tenant_local',
          userId: record.context?.userId || record.userId || 'user_local',
          traceId: record.context?.traceId || record.traceId,
          context: record.context,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: record.durationMs,
          prompt: record.input?.prompt,
          error: record.error?.message,
          path: fullPath,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))
    .slice(0, limit);
}
