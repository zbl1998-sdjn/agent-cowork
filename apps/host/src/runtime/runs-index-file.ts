// 运行索引·文件后端(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:基于「事件日志(jsonl)」的运行索引文件后端——以 upsert 事件追加方式维护可查询索引,
//       按 tenant/user/trace 归一化记录。与 SQLite 后端同接口(端口与适配器)。
// 依赖:node:fs/path + 同层 runs-index-utils。导出:RunsIndex。
import fs from 'node:fs';
import path from 'node:path';
import {
  normaliseRecord,
  normaliseTenantId,
  normaliseUserId,
  type NormalisedRunRecord,
} from './runs-index-utils.js';

export type RunIndexRecord = NormalisedRunRecord & Record<string, unknown>;
export type RunIndexEvent = {
  id?: unknown;
  op?: string;
  record?: RunIndexRecord;
  tenantId?: string;
  userId?: string;
  traceId?: unknown;
  ts?: unknown;
};
export type RunsIndexOptions = { indexRoot?: string; now?: () => Date };
export type RunsIndexContext = { traceId?: unknown };
export type RunsIndexListOptions = {
  tenantId?: unknown;
  userId?: unknown;
  limit?: unknown;
  status?: unknown;
  type?: unknown;
  recipeId?: unknown;
};

function ensureDirSync(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(file: string, event: RunIndexEvent): void {
  ensureDirSync(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function readJsonl(file: string): RunIndexEvent[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RunIndexEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is RunIndexEvent => Boolean(event));
}

export class RunsIndex {
  readonly indexRoot: string;
  readonly eventFile: string;
  readonly now: () => Date;
  readonly records: Map<string, RunIndexRecord>;

  constructor({ indexRoot, now = () => new Date() }: RunsIndexOptions = {}) {
    if (!indexRoot || typeof indexRoot !== 'string') {
      throw new Error('RunsIndex: indexRoot is required');
    }
    this.indexRoot = indexRoot;
    this.eventFile = path.join(indexRoot, 'index.jsonl');
    this.now = now;
    this.records = new Map<string, RunIndexRecord>();
    this._replay();
  }

  _replay(): void {
    const events = readJsonl(this.eventFile);
    for (const event of events) {
      if (!event || !event.id) {
        continue;
      }
      const id = String(event.id);
      if (event.op === 'delete') {
        this.records.delete(id);
        continue;
      }
      const previous = this.records.get(id) || {};
      this.records.set(id, { ...previous, ...event.record } as RunIndexRecord);
    }
  }

  upsert(record: unknown, context: RunsIndexContext = {}): RunIndexRecord {
    const normalised = normaliseRecord(record) as RunIndexRecord;
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

  remove(id: unknown, context: RunsIndexContext = {}): boolean {
    const existing = typeof id === 'string' ? this.records.get(id) : undefined;
    if (!existing) {
      return false;
    }
    this.records.delete(id as string);
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

  get(id: unknown, { tenantId }: { tenantId?: unknown } = {}): RunIndexRecord | null {
    const record = typeof id === 'string' ? this.records.get(id) : undefined;
    if (!record) {
      return null;
    }
    if (tenantId && record.tenantId !== normaliseTenantId(tenantId)) {
      return null;
    }
    return record;
  }

  list({
    tenantId,
    userId,
    limit = 50,
    status,
    type,
    recipeId,
  }: RunsIndexListOptions = {}): RunIndexRecord[] {
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    const wantUser = userId ? normaliseUserId(userId) : null;
    const out: RunIndexRecord[] = [];
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

  size(): number {
    return this.records.size;
  }

  stats({ tenantId }: { tenantId?: unknown } = {}): {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  } {
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    let total = 0;
    const byStatus: Record<string, number> = Object.create(null);
    const byType: Record<string, number> = Object.create(null);
    for (const record of this.records.values()) {
      if (wantTenant && record.tenantId !== wantTenant) continue;
      total += 1;
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      byType[record.type] = (byType[record.type] || 0) + 1;
    }
    return { total, byStatus, byType };
  }
}
