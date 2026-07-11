// 运行索引·文件后端(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:基于「事件日志(jsonl)」的运行索引文件后端——以 upsert 事件追加方式维护可查询索引,
//       按 tenant/user/trace 归一化记录。与 SQLite 后端同接口(端口与适配器)。
// 依赖:node:fs/path + 同层 runs-index-utils。导出:RunsIndex。
import path from 'node:path';
import {
  canonicalIdentityFilter,
  canonicalRequiredIdentityScope,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';
import { ManagedStateFilesystem } from '../security/managed-state-filesystem.js';
import {
  ensureRunOwnerClaim,
  normalizeRunOwner,
  runOwnerClaimPath,
} from '../util/run-owner.js';
import { normaliseRecord } from './runs-index-utils.js';
import {
  appendRunIndexEvent,
  readRunIndexEvents,
  type RunIndexRecord,
} from './runs-index-jsonl.js';

export type { RunIndexEvent, RunIndexRecord } from './runs-index-jsonl.js';
export type RunsIndexOptions = { indexRoot?: string; now?: () => Date };
export type RunsIndexContext = { tenantId?: unknown; userId?: unknown; traceId?: unknown };
export type RunsIndexListOptions = {
  tenantId?: unknown;
  userId?: unknown;
  limit?: unknown;
  status?: unknown;
  type?: unknown;
  recipeId?: unknown;
};

function requireOwnerContext(context: RunsIndexContext): { tenantId: string; userId: string } {
  return requireIdentityScopeFrom(context, { label: 'runs-index owner context' });
}

export class RunsIndex {
  readonly indexRoot: string;
  readonly eventFile: string;
  readonly now: () => Date;
  readonly records: Map<string, RunIndexRecord>;
  private readonly filesystem: ManagedStateFilesystem;

  constructor({ indexRoot, now = () => new Date() }: RunsIndexOptions = {}) {
    if (!indexRoot || typeof indexRoot !== 'string') {
      throw new Error('RunsIndex: indexRoot is required');
    }
    this.filesystem = new ManagedStateFilesystem(indexRoot, { label: 'Runs index' });
    this.indexRoot = this.filesystem.rootPath;
    this.eventFile = path.join(this.indexRoot, 'index.jsonl');
    this.now = now;
    this.records = new Map<string, RunIndexRecord>();
    this._replay();
  }

  _replay(): void {
    const events = readRunIndexEvents(this.eventFile, this.filesystem);
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !event.id) {
        continue;
      }
      const id = event.id;
      const previous = this.records.get(id);
      const eventOwner = canonicalRequiredIdentityScope(event.tenantId, event.userId);
      if (!eventOwner) continue;
      if (event.op === 'delete') {
        if (
          !previous
          || eventOwner.tenantId !== previous.tenantId
          || eventOwner.userId !== previous.userId
        ) {
          if (previous) {
            throw new Error('runs-index event cannot delete another owner record');
          }
          continue;
        }
        this.records.delete(id);
        continue;
      }
      if (!event.record || event.record.id !== id) continue;
      const recordOwner = canonicalRequiredIdentityScope(
        event.record.tenantId,
        event.record.userId,
      );
      if (
        !recordOwner
        || recordOwner.tenantId !== eventOwner.tenantId
        || recordOwner.userId !== eventOwner.userId
      ) {
        continue;
      }
      const next = { ...(previous || {}), ...event.record } as RunIndexRecord;
      if (previous && (previous.tenantId !== next.tenantId || previous.userId !== next.userId)) {
        throw new Error('runs-index event cannot replace another owner record');
      }
      this.records.set(id, next);
    }
  }

  upsert(record: unknown, context: RunsIndexContext = {}): RunIndexRecord {
    const normalised = normaliseRecord(record) as RunIndexRecord;
    const existing = this.records.get(normalised.id);
    if (existing) {
      if (existing.tenantId !== normalised.tenantId || existing.userId !== normalised.userId) {
        throw new Error('runs-index: id already belongs to another owner');
      }
      normalised.version = (Number(existing.version) || 0) + 1;
    }
    const claimPath = runOwnerClaimPath(this.indexRoot, normalised.id);
    ensureRunOwnerClaim({
      claimPath,
      owner: normalizeRunOwner(normalised, { label: 'Runs index owner' }),
      label: 'Runs index record',
      beforeFilesystemMutation: this.filesystem.guardMutation,
      boundary: this.filesystem.boundary,
    });
    this.filesystem.guardMutation(claimPath);
    normalised.updatedAt = this.now().toISOString();
    appendRunIndexEvent(this.eventFile, {
      ts: normalised.updatedAt,
      op: 'upsert',
      id: normalised.id,
      tenantId: normalised.tenantId,
      userId: normalised.userId,
      traceId: context.traceId || normalised.traceId,
      record: normalised,
    }, this.filesystem);
    this.records.set(normalised.id, normalised);
    return normalised;
  }

  remove(id: unknown, context: RunsIndexContext = {}): boolean {
    const owner = requireOwnerContext(context);
    const existing = typeof id === 'string' ? this.records.get(id) : undefined;
    if (!existing || existing.tenantId !== owner.tenantId || existing.userId !== owner.userId) {
      return false;
    }
    appendRunIndexEvent(this.eventFile, {
      ts: this.now().toISOString(),
      op: 'delete',
      id,
      tenantId: existing.tenantId,
      userId: existing.userId,
      traceId: context.traceId || existing.traceId,
    }, this.filesystem);
    this.records.delete(id as string);
    return true;
  }

  get(id: unknown, options: { tenantId?: unknown; userId?: unknown } = {}): RunIndexRecord | null {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const record = typeof id === 'string' ? this.records.get(id) : undefined;
    if (!record) {
      return null;
    }
    if (tenantId && record.tenantId !== tenantId) {
      return null;
    }
    if (userId && record.userId !== userId) {
      return null;
    }
    return record;
  }

  list(options: RunsIndexListOptions = {}): RunIndexRecord[] {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const {
      limit = 50,
      status,
      type,
      recipeId,
    } = options;
    const wantTenant = tenantId || null;
    const wantUser = userId || null;
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

  stats(options: { tenantId?: unknown; userId?: unknown } = {}): {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  } {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const wantTenant = tenantId || null;
    const wantUser = userId || null;
    let total = 0;
    const byStatus: Record<string, number> = Object.create(null);
    const byType: Record<string, number> = Object.create(null);
    for (const record of this.records.values()) {
      if (wantTenant && record.tenantId !== wantTenant) continue;
      if (wantUser && record.userId !== wantUser) continue;
      total += 1;
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      byType[record.type] = (byType[record.type] || 0) + 1;
    }
    return { total, byStatus, byType };
  }
}
