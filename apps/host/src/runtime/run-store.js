// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withRunAttribution } from './run-attribution.js';
import { withRunMetrics } from './run-metrics.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * @typedef {{
 *   id: string,
 *   type?: unknown,
 *   status?: unknown,
 *   provider?: unknown,
 *   mode?: unknown,
 *   recipeId?: unknown,
 *   tenantId?: unknown,
 *   userId?: unknown,
 *   traceId?: unknown,
 *   context?: Record<string, unknown>,
 *   startedAt?: unknown,
 *   finishedAt?: unknown,
 *   durationMs?: unknown,
 *   input?: { prompt?: unknown },
 *   error?: { message?: unknown },
 *   [key: string]: unknown,
 * }} RunRecord
 *
 * @typedef {{
 *   id: string,
 *   type: unknown,
 *   status: unknown,
 *   mode: unknown,
 *   provider: unknown,
 *   recipeId: unknown,
 *   tenantId: unknown,
 *   userId: unknown,
 *   traceId: unknown,
 *   context: Record<string, unknown> | undefined,
 *   startedAt: unknown,
 *   finishedAt: unknown,
 *   durationMs: unknown,
 *   prompt: unknown,
 *   error: unknown,
 *   path: string,
 * }} RunSummary
 */

/**
 * @param {Date} [now]
 * @param {{ randomHex?: (length: number) => string }} [options]
 * @returns {string}
 */
export function createRunId(now = new Date(), { randomHex } = {}) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = typeof randomHex === 'function'
    ? randomHex(8)
    : crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `run_${timestamp}_${suffix}`;
}

/**
 * @param {string} runStoreRoot
 * @param {string} runId
 * @returns {string}
 */
export function getRunPath(runStoreRoot, runId) {
  if (!RUN_ID_RE.test(runId || '')) {
    throw new Error('Invalid run id');
  }
  return path.join(runStoreRoot, `${runId}.json`);
}

/**
 * @param {string} runStoreRoot
 * @param {RunRecord} record
 * @returns {string}
 */
export function writeRunRecord(runStoreRoot, record) {
  if (!record || typeof record.id !== 'string' || !record.id.trim()) {
    throw new Error('Run record id is required');
  }
  fs.mkdirSync(runStoreRoot, { recursive: true });
  const enriched = /** @type {RunRecord} */ (withRunMetrics(withRunAttribution(record)));
  const runPath = getRunPath(runStoreRoot, enriched.id);
  fs.writeFileSync(runPath, `${JSON.stringify(enriched, null, 2)}\n`, 'utf8');
  return runPath;
}

/**
 * @param {string} runStoreRoot
 * @param {string} runId
 * @returns {RunRecord | null}
 */
export function readRunRecord(runStoreRoot, runId) {
  const runPath = getRunPath(runStoreRoot, runId);
  if (!fs.existsSync(runPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(runPath, 'utf8'));
}

/**
 * @param {string} runStoreRoot
 * @param {{ limit?: number }} [options]
 * @returns {RunSummary[]}
 */
export function listRunRecords(runStoreRoot, { limit = 20 } = {}) {
  if (!fs.existsSync(runStoreRoot)) {
    return [];
  }
  /** @type {RunSummary[]} */
  const records = [];
  for (const entry of fs.readdirSync(runStoreRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(runStoreRoot, entry.name);
    try {
      const record = /** @type {RunRecord} */ (JSON.parse(fs.readFileSync(fullPath, 'utf8')));
      records.push({
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
      });
    } catch {
      // Ignore malformed run records; listing should remain best-effort.
    }
  }
  return records
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))
    .slice(0, limit);
}
