//
// 审批登记表(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:Agent 想运行高危/变更类工具(Write/Edit/Shell)时在此登记并 await 决定:once(本次)/
//       session(本次并整轮自动放行该工具)/reject(跳过)。UI POST /api/approvals/:id 解决该 promise。
// 健壮性:待决项带时间戳并按 TTL 清理、map 有上限;cancelByRun 在流断开时释放该 run 的待决请求,杜绝泄漏/卡死。
// 依赖:node:crypto。导出:审批登记表工厂。
// Approval registry for the agent loop (Kimi CLI / Claude Cowork style).
//
// When the agent wants to run a mutating tool (Write/Edit/Shell), it asks for
// approval and awaits a decision: 'once' (run this time), 'session' (run + auto
// -approve this tool for the rest of the run), or 'reject' (skip). The UI posts
// the decision to POST /api/approvals/:id, which resolves the pending promise.
//
// Concurrency hardening (multi-user readiness): pending entries carry a
// timestamp and are pruned past a TTL, and the map is capped — so abandoned
// SSE streams (client closed mid-approval) can never leak unbounded memory or
// leave the agent loop awaiting forever. `cancelByRun` unblocks a single run's
// pending requests when its stream disconnects.

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
  const pending = new Map<string, PendingApproval>(); // id -> { resolve, meta, ts }

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
      // Capacity guard: under sustained load drop the oldest pending request
      // (resolve 'reject') so the map can never grow without bound.
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next().value;
        if (!oldest) break;
        const entry = pending.get(oldest);
        pending.delete(oldest);
        if (entry) entry.resolve('reject');
      }
      const id = `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      let resolve: (value: unknown) => void = () => {};
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
    // Resolve a pending request with an arbitrary free-form value (used by
    // AskUserQuestion, where the answer is the chosen option text, not a
    // fixed approve/reject decision).
    respond(id, value, context = null) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (!sameScope(entry.meta, context)) return false;
      pending.delete(id);
      entry.resolve(value);
      return true;
    },
    // Resolve every pending request tagged with a given runId — used when an SSE
    // stream disconnects so its awaiting agent loop unblocks and exits cleanly.
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
