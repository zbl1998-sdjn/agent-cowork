//
// 审批登记表(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:Agent 想运行高危/变更类工具(Write/Edit/Shell)时在此登记并 await 决定:once(本次)/
//       session(本次并整轮自动放行该工具)/reject(跳过)。UI POST /api/approvals/:id 解决该 promise。
// 健壮性:待决项带时间戳并按 TTL 清理、map 有上限;cancelByRun 在流断开时释放该 run 的待决请求,杜绝泄漏/卡死。
// 依赖:node:crypto。导出:审批登记表工厂。

import crypto from 'node:crypto';

export type ApprovalDecision = 'once' | 'session' | 'reject';

export type ApprovalMeta = {
  tenantId?: string;
  userId?: string;
  runId?: string;
  [key: string]: unknown;
};

export type ApprovalContext = {
  tenantId?: unknown;
  userId?: unknown;
};

type PendingApproval = {
  resolve: (value: unknown) => void;
  meta: ApprovalMeta;
  ts: number;
};

export type ApprovalRegistryOptions = {
  ttlMs?: number;
  maxPending?: number;
};

export type ApprovalResult = {
  id: unknown;
  ok: boolean;
};

export type ApprovalRegistry = {
  request(meta?: ApprovalMeta): { id: string; promise: Promise<unknown> };
  resolve(id: string, decision: unknown, context?: ApprovalContext | null): boolean;
  resolveMany(
    ids: unknown,
    decision: unknown,
    context?: ApprovalContext | null,
  ): ApprovalResult[];
  respond(id: string, value: unknown, context?: ApprovalContext | null): boolean;
  cancelByRun(runId: unknown, decision?: unknown): number;
  cancelAll(decision?: unknown): void;
  pendingCount(): number;
  prune(now?: number): number;
};

const DECISIONS = new Set<ApprovalDecision>(['once', 'session', 'reject']);

function sameScope(meta: ApprovalMeta = {}, context: ApprovalContext | null = null): boolean {
  const tenantId = meta.tenantId || '';
  const userId = meta.userId || '';
  if (!tenantId && !userId) return true;
  if (!context) return false;
  if (tenantId && context.tenantId !== tenantId) return false;
  if (userId && context.userId !== userId) return false;
  return true;
}

function normalizeDecision(decision: unknown): ApprovalDecision {
  return typeof decision === 'string' && DECISIONS.has(decision as ApprovalDecision)
    ? decision as ApprovalDecision
    : 'reject';
}

export function createApprovalRegistry({
  ttlMs = 15 * 60 * 1000,
  maxPending = 10000,
}: ApprovalRegistryOptions = {}): ApprovalRegistry {
  // id -> { resolve, meta, ts };ts 用于 TTL 清理,meta 用于租户/用户/run 作用域校验。
  const pending = new Map<string, PendingApproval>();

  function prune(now = Date.now()): number {
    let n = 0;
    for (const [id, entry] of pending) {
      if (now - entry.ts > ttlMs) {
        pending.delete(id);
        entry.resolve('reject'); // unblock any awaiter so abandoned turns never hang
        n += 1;
      }
    }
    return n;
  }

  return {
    request(meta = {}) {
      prune();
      // 容量闸门:持续高负载下丢弃最旧待决项并 resolve 为 reject,保证 map 不会无界增长。
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next().value;
        if (!oldest) break;
        const entry = pending.get(oldest);
        pending.delete(oldest);
        if (entry) entry.resolve('reject');
      }
      const id = `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      let resolve: (value: unknown) => void = () => undefined;
      const promise = new Promise<unknown>((resolver) => { resolve = resolver; });
      pending.set(id, { resolve, meta, ts: Date.now() });
      return { id, promise };
    },
    resolve(id, decision, context = null) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (!sameScope(entry.meta, context)) return false;
      pending.delete(id);
      entry.resolve(normalizeDecision(decision));
      return true;
    },
    resolveMany(ids, decision, context = null) {
      const uniqueIds = [...new Set(Array.isArray(ids) ? ids : [])];
      const normalizedDecision = normalizeDecision(decision);
      return uniqueIds.map((id) => {
        const entry = typeof id === 'string' ? pending.get(id) : undefined;
        if (!entry || !sameScope(entry.meta, context)) return { id, ok: false };
        pending.delete(id);
        entry.resolve(normalizedDecision);
        return { id, ok: true };
      });
    },
    // 用任意自由值解决待决请求。AskUserQuestion 走这里:答案是用户选择/输入的文本,
    // 不是固定 approve/reject 决策。
    respond(id, value, context = null) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (!sameScope(entry.meta, context)) return false;
      pending.delete(id);
      entry.resolve(value);
      return true;
    },
    // 释放指定 runId 下全部待决请求;SSE 断开时调用,让等待中的 agent loop 解阻并干净退出。
    cancelByRun(runId, decision = 'reject') {
      if (!runId) return 0;
      let n = 0;
      for (const [id, entry] of pending) {
        if (entry.meta && entry.meta.runId === runId) {
          pending.delete(id);
          entry.resolve(decision);
          n += 1;
        }
      }
      return n;
    },
    cancelAll(decision = 'reject') {
      for (const [id, entry] of pending) {
        entry.resolve(decision);
        pending.delete(id);
      }
    },
    pendingCount() {
      return pending.size;
    },
    prune,
  };
}
