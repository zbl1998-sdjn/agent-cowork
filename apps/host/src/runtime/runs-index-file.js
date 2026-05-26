import fs from 'node:fs';
import path from 'node:path';
import { normaliseRecord, normaliseTenantId, normaliseUserId } from './runs-index-utils.js';

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(file, event) {
  ensureDirSync(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export class RunsIndex {
  constructor({ indexRoot, now = () => new Date() } = {}) {
    if (!indexRoot || typeof indexRoot !== 'string') {
      throw new Error('RunsIndex: indexRoot is required');
    }
    this.indexRoot = indexRoot;
    this.eventFile = path.join(indexRoot, 'index.jsonl');
    this.now = now;
    this.records = new Map();
    this._replay();
  }

  _replay() {
    const events = readJsonl(this.eventFile);
    for (const event of events) {
      if (!event || !event.id) {
        continue;
      }
      if (event.op === 'delete') {
        this.records.delete(event.id);
        continue;
      }
      const previous = this.records.get(event.id) || {};
      this.records.set(event.id, { ...previous, ...event.record });
    }
  }

  upsert(record, context = {}) {
    const normalised = normaliseRecord(record);
    const existing = this.records.get(normalised.id);
    if (existing) {
      normalised.version = (Number(existing.version) || 0) + 1;
    }
    normalised.updatedAt = this.now().toISOString();
    this.records.set(normalised.id, normalised);
    appendJsonl(this.eventFile, {
      ts: normalised.updatedAt,
      op: 'upsert',
      id: normalised.id,
      tenantId: normalised.tenantId,
      userId: normalised.userId,
      traceId: context.traceId || normalised.traceId,
      record: normalised,
    });
    return normalised;
  }

  remove(id, context = {}) {
    const existing = this.records.get(id);
    if (!existing) {
      return false;
    }
    this.records.delete(id);
    appendJsonl(this.eventFile, {
      ts: this.now().toISOString(),
      op: 'delete',
      id,
      tenantId: existing.tenantId,
      userId: existing.userId,
      traceId: context.traceId || existing.traceId,
    });
    return true;
  }

  get(id, { tenantId } = {}) {
    const record = this.records.get(id);
    if (!record) {
      return null;
    }
    if (tenantId && record.tenantId !== normaliseTenantId(tenantId)) {
      return null;
    }
    return record;
  }

  list({ tenantId, userId, limit = 50, status, type, recipeId } = {}) {
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    const wantUser = userId ? normaliseUserId(userId) : null;
    const out = [];
    for (const record of this.records.values()) {
      if (wantTenant && record.tenantId !== wantTenant) continue;
      if (wantUser && record.userId !== wantUser) continue;
      if (status && record.status !== status) continue;
      if (type && record.type !== type) continue;
      if (recipeId && record.recipeId !== recipeId) continue;
      out.push(record);
    }
    out.sort((a, b) => String(b.startedAt || b.updatedAt).localeCompare(String(a.startedAt || a.updatedAt)));
    const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
    return out.slice(0, cap);
  }

  size() {
    return this.records.size;
  }

  stats({ tenantId } = {}) {
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    let total = 0;
    const byStatus = Object.create(null);
    const byType = Object.create(null);
    for (const record of this.records.values()) {
      if (wantTenant && record.tenantId !== wantTenant) continue;
      total += 1;
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      byType[record.type] = (byType[record.type] || 0) + 1;
    }
    return { total, byStatus, byType };
  }
}
