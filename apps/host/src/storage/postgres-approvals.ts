import {
  type ApprovalChannel,
  type ApprovalContext,
  type ApprovalMeta,
  defaultApprovalId,
  matchesChannel,
  normalizeDecision,
  positiveIntegerOption,
  reconcilePersistedApproval,
  type PostgresApprovalStoreOptions,
  requiredScope,
  sameScope,
} from './postgres-approval-support.js';
import { PostgresApprovalDatabase } from './postgres-approval-database.js';
import { encodePostgresApprovalAnswer } from './postgres-approval-answer.js';
import { createPostgresApprovalCatchUp } from './postgres-approval-catch-up.js';
type ApprovalResolve = (decision: unknown) => void;
type LocalApproval = { resolve: ApprovalResolve; meta: ApprovalMeta; persistence: Promise<void>; createdAt: number };
export type { PostgresApprovalStoreOptions } from './postgres-approval-support.js';
export class PostgresApprovalStore {
  private _database: PostgresApprovalDatabase;
  private _local: Map<string, LocalApproval>;
  private _generateId: () => string;
  private _ttlMs: number;
  private _maxPending: number;
  private _pruneIntervalMs: number;
  private _pruneTimer: ReturnType<typeof setInterval> | null;
  private _onError: (message: string) => void;
  constructor({
    client = null,
    pool = null,
    connectionString = null,
    channel = 'kcw_approvals',
    generateId = defaultApprovalId,
    pg = null,
    ttlMs = 15 * 60 * 1000,
    maxPending = 10000,
    pruneIntervalMs = 60 * 1000,
    connectionTimeoutMs = 5000,
    queryTimeoutMs = 10000,
    reconnectAttempts = 3,
    reconnectDelayMs = 100,
    onError = (message) => console.error('[postgres-approvals]', message),
  }: PostgresApprovalStoreOptions = {}) {
    this._local = new Map(); // id -> { resolve, meta },仅保存本实例正在等待的 promise。
    this._generateId = generateId;
    this._ttlMs = positiveIntegerOption('ttlMs', ttlMs, 15 * 60 * 1000, { allowZero: true });
    this._maxPending = positiveIntegerOption('maxPending', maxPending, 10000);
    this._pruneIntervalMs = positiveIntegerOption('pruneIntervalMs', pruneIntervalMs, 60 * 1000, { allowZero: true });
    this._onError = onError;
    const catchUp = createPostgresApprovalCatchUp({
      snapshot: () => [...this._local],
      reconcile: (id, entry) => this._reconcileNotification(id, 3, entry),
      onError: () => this._reportError('LISTEN catch-up failed'),
    });
    this._database = new PostgresApprovalDatabase({
      client,
      pool,
      connectionString,
      channel,
      pg,
      connectionTimeoutMs: positiveIntegerOption('connectionTimeoutMs', connectionTimeoutMs, 5000),
      queryTimeoutMs: positiveIntegerOption('queryTimeoutMs', queryTimeoutMs, 10000),
      reconnectAttempts: positiveIntegerOption(
        'reconnectAttempts', reconnectAttempts, 3, { allowZero: true },
      ),
      reconnectDelayMs: positiveIntegerOption(
        'reconnectDelayMs', reconnectDelayMs, 100, { allowZero: true },
      ),
      onNotification: (id) => { void this._reconcileNotification(id); },
      onListening: () => catchUp(),
      onError: (message) => this._reportError(message),
    });
    this._pruneTimer = null;
  }

  private _reportError(message: string): void { try { this._onError(message); } catch { /* 错误报告器不得制造第二个未处理异常 */ } }
  private async _reconcileNotification(id: string, attemptsRemaining = 3, expected: LocalApproval | null = null): Promise<void> {
    const entry = this._local.get(id);
    if (!entry || (expected && entry !== expected)) return;
    await reconcilePersistedApproval({
      id,
      meta: entry.meta,
      persistence: entry.persistence,
      read: (scope) => this._database.read(id, scope),
      isCurrent: () => this._local.get(id) === entry,
      settle: (decision) => { this._local.delete(id); entry.resolve(decision); },
      reportError: (message) => this._reportError(message),
    }, attemptsRemaining);
  }

  private _startPruneTimer(): void {
    if (this._pruneTimer || this._pruneIntervalMs === 0) return;
    this._pruneTimer = setInterval(() => {
      void this.prune(this._ttlMs).catch(() => {
        this._reportError('scheduled approval prune failed');
      });
    }, this._pruneIntervalMs);
    const timer = this._pruneTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  async start(): Promise<void> {
    await this._database.start();
    this._startPruneTimer();
  }

  request(meta: ApprovalMeta = {}): { id: string; ready: Promise<void>; promise: Promise<unknown> } {
    const scope = requiredScope(meta);
    if (!scope) {
      throw new Error('PostgresApprovalStore: request requires non-empty tenantId and userId');
    }
    if (this._local.size >= this._maxPending) {
      throw new Error('PostgresApprovalStore: pending approval capacity exceeded');
    }
    const id = this._generateId();
    if (this._local.has(id)) {
      throw new Error('PostgresApprovalStore: generated approval id collision');
    }
    let resolve: ApprovalResolve = () => undefined;
    const decision = new Promise<unknown>((r) => { resolve = r; });
    const entry: LocalApproval = {
      resolve,
      meta: { ...meta, ...scope },
      persistence: Promise.resolve(),
      createdAt: Date.now(),
    };
    const persistence = this._database.insert(id, meta, scope)
      .catch((cause: unknown) => {
        if (this._local.get(id) === entry) this._local.delete(id);
        throw new Error('PostgresApprovalStore: approval persistence failed', { cause });
      });
    entry.persistence = persistence;
    const promise = persistence.then(() => decision);
    // ready 失败时消费者会先返回；预先挂拒绝处理，避免派生 promise 产生未处理拒绝。
    void promise.catch(() => undefined);
    this._local.set(id, entry);
    return { id, ready: persistence, promise };
  }

  async _resolveRow(
    id: string,
    decision: unknown,
    context: ApprovalContext | null,
    channel: ApprovalChannel,
  ): Promise<boolean> {
    const scope = requiredScope(context);
    if (!scope) return false;
    const persistedDecision = channel === 'answer'
      ? encodePostgresApprovalAnswer(decision)
      : decision;
    const localBeforeQuery = this._local.get(id);
    if (localBeforeQuery && sameScope(localBeforeQuery.meta, context) && matchesChannel(localBeforeQuery.meta, channel)) {
      try {
        await localBeforeQuery.persistence;
      } catch {
        return false;
      }
    }
    const rowMatched = await this._database.resolve(id, persistedDecision, scope, channel);
    const local = this._local.get(id);
    const localMatched = !!(rowMatched && local && sameScope(local.meta, context) && matchesChannel(local.meta, channel));
    if (localMatched) { this._local.delete(id); local.resolve(decision); }
    return rowMatched;
  }

  async resolve(id: string, decision: unknown, context: ApprovalContext | null = null): Promise<boolean> {
    const normalized = normalizeDecision(decision);
    return normalized ? this._resolveRow(id, normalized, context, 'decision') : false;
  }

  async resolveMany(ids: unknown, decision: unknown, context: ApprovalContext | null = null): Promise<Array<{ id: string; ok: boolean }>> {
    const uniqueIds = [...new Set(Array.isArray(ids) ? ids.map((id) => String(id)) : [])];
    const results: Array<{ id: string; ok: boolean }> = [];
    for (const id of uniqueIds) {
      results.push({ id, ok: await this.resolve(id, decision, context) });
    }
    return results;
  }

  async respond(id: string, value: unknown, context: ApprovalContext | null = null): Promise<boolean> {
    return this._resolveRow(id, value, context, 'answer');
  }

  async cancelByRun(runId: unknown, context: ApprovalContext | null = null): Promise<number> {
    if (!runId) return 0;
    const scope = requiredScope(context);
    if (!scope) return 0;
    const cancelledIds = new Set<string>();
    const pendingPersistence: Promise<void>[] = [];
    for (const [id, entry] of this._local) {
      if (entry.meta.runId === runId && sameScope(entry.meta, context)) {
        this._local.delete(id);
        entry.resolve('reject');
        cancelledIds.add(id);
        pendingPersistence.push(entry.persistence);
      }
    }
    // INSERT 与取消可能并发。先释放本地等待者，再等已发出的 INSERT 收口，
    // 确保后续 UPDATE 不会先于 INSERT 执行而遗留孤儿 pending 行。
    await Promise.allSettled(pendingPersistence);
    const mutation = await this._database.cancelByRun(runId, scope);
    for (const id of mutation.ids) {
      if (id) cancelledIds.add(id);
    }
    return Math.max(cancelledIds.size, mutation.count);
  }

  async pendingCount(): Promise<number> {
    return this._database.pendingCount();
  }

  async prune(ttlMs = 15 * 60 * 1000): Promise<number> {
    const ttl = positiveIntegerOption('ttlMs', ttlMs, this._ttlMs, { allowZero: true });
    const cutoff = Date.now() - ttl;
    for (const [id, entry] of this._local) {
      if (entry.createdAt <= cutoff) {
        this._local.delete(id);
        entry.resolve('reject');
      }
    }
    const mutation = await this._database.prune(ttl);
    for (const id of mutation.ids) {
      const local = this._local.get(id);
      if (local) { this._local.delete(id); local.resolve('reject'); }
    }
    return mutation.count;
  }

  async stop(): Promise<void> {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    this._pruneTimer = null;
    this.cancelAll();
    await this._database.stop();
  }

  cancelAll(): void {
    for (const [id, entry] of this._local) {
      this._local.delete(id);
      entry.resolve('reject');
    }
  }
}

export function createPostgresApprovalStore(options: PostgresApprovalStoreOptions = {}): PostgresApprovalStore {
  return new PostgresApprovalStore(options);
}
