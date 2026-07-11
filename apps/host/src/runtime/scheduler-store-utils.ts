// Shared schedule store parsing and scope helpers (host · L2 · runtime).
import fs from 'node:fs';
import {
  canonicalIdentityFilter,
  canonicalIdentityPart,
  canonicalRequiredIdentityScope,
} from '../security/identity-scope.js';
import type { ScheduleListOptions, ScheduleRecord } from './scheduler-store-types.js';

export type ScheduleRow = { schedule_json: string };

function isStoredScheduleRecord(value: unknown): value is ScheduleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'name', 'kind', 'status']) {
    if (typeof record[key] !== 'string' || !(record[key] as string).trim()) return false;
  }
  return canonicalRequiredIdentityScope(record.tenantId, record.userId) !== null;
}

export function ensureScheduleDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function normaliseTenantId(value: unknown): string {
  const canonical = canonicalIdentityPart(value);
  if (!canonical) throw new Error('scheduler tenantId: canonical identity part is required');
  return canonical;
}

export function normaliseUserId(value: unknown): string {
  const canonical = canonicalIdentityPart(value);
  if (!canonical) throw new Error('scheduler userId: canonical identity part is required');
  return canonical;
}

export function scheduleMatchesScope(
  record: ScheduleRecord,
  options: ScheduleListOptions = {},
): boolean {
  const { tenantId, userId } = canonicalIdentityFilter(options);
  const owner = canonicalRequiredIdentityScope(record.tenantId, record.userId);
  if (!owner) return false;
  if (tenantId && owner.tenantId !== tenantId) return false;
  return !userId || owner.userId === userId;
}

export function sqliteScheduleScope(
  options: ScheduleListOptions = {},
): { where: string[]; params: unknown[] } {
  const { tenantId, userId } = canonicalIdentityFilter(options);
  const where: string[] = [];
  const params: unknown[] = [];
  if (tenantId) { where.push('tenant_id = ?'); params.push(tenantId); }
  if (userId) { where.push('user_id = ?'); params.push(userId); }
  return { where, params };
}

export function readScheduleFile(file: string, expectedId?: string): ScheduleRecord | null {
  try {
    const record: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isStoredScheduleRecord(record)) return null;
    return expectedId === undefined || record.id === expectedId ? record : null;
  } catch (error) {
    void error;
    return null;
  }
}

export function parseScheduleRow(row: unknown): ScheduleRecord | null {
  try {
    const record: unknown = JSON.parse((row as ScheduleRow).schedule_json);
    return isStoredScheduleRecord(record) ? record : null;
  } catch (error) {
    void error;
    return null;
  }
}
