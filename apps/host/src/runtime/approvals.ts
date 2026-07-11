//
// 审批登记表(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:Agent 想运行高危/变更类工具(Write/Edit/Shell)时在此登记并 await 决定:once(本次)/
//       session(本次并整轮自动放行该工具)/reject(跳过)。UI POST /api/approvals/:id 解决该 promise。
// 健壮性:待决项带时间戳并按 TTL 清理、map 有上限;cancelByRun 在流断开时释放该 run 的待决请求,杜绝泄漏/卡死。
// 依赖:node:crypto。导出:审批登记表工厂。

import crypto from 'node:crypto';
import { requireIdentityScopeFrom, type IdentityScope } from '../security/identity-scope.js';

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
  expiryTimer: ReturnType<typeof setTimeout> | null;
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
  request(meta?: ApprovalMeta): { id: string; ready: Promise<void>; promise: Promise<unknown> };
  resolve(id: string, decision: unknown, context?: ApprovalContext | null): boolean;
  resolveMany(
    ids: unknown,
    decision: unknown,
    context?: ApprovalContext | null,
  ): ApprovalResult[];
  respond(id: string, value: unknown, context?: ApprovalContext | null): boolean;
  cancelByRun(runId: unknown, context?: ApprovalContext | null): number;
  cancelAll(decision?: unknown): void;
  pendingCount(): number;
  prune(now?: number): number;
};

const DECISIONS = new Set<ApprovalDecision>(['once', 'session', 'reject']);

function hasOwnIdentity(meta: ApprovalMeta): boolean {
  return Boolean(
    Object.getOwnPropertyDescriptor(meta, 'tenantId')
    || Object.getOwnPropertyDescriptor(meta, 'userId'),
  );
}

function approvalOwner(meta: ApprovalMeta): IdentityScope | null {
  return hasOwnIdentity(meta)
    ? requireIdentityScopeFrom(meta, { label: 'approval identity' })
    : null;
}

function normalizeApprovalMeta(meta: ApprovalMeta): ApprovalMeta {
  const owner = approvalOwner(meta);
  return owner ? { ...meta, ...owner } : meta;
}

function sameScope(meta: ApprovalMeta = {}, context: ApprovalContext | null = null): boolean {
  const owner = approvalOwner(meta);
  if (context === null) return owner === null;
  const caller = requireIdentityScopeFrom(context, { label: 'approval caller identity' });
  if (!owner) return false;
  return owner.tenantId === caller.tenantId
    && owner.userId === caller.userId;
}

function normalizeDecision(decision: unknown): ApprovalDecision | null {
  return typeof decision === 'string' && DECISIONS.has(decision as ApprovalDecision)
    ? decision as ApprovalDecision
    : null;
}

function isQuestion(meta: ApprovalMeta): boolean {
  return meta.kind === 'question';
}

export function createApprovalRegistry({
  ttlMs = 15 * 60 * 1000,
  maxPending = 10000,
}: ApprovalRegistryOptions = {}): ApprovalRegistry {
  // id -> { resolve, meta, ts };ts 用于 TTL 清理,meta 用于租户/用户/run 作用域校验。
  const pending = new Map<string, PendingApproval>();
  const expiryDelayMs = Number.isFinite(ttlMs) ? Math.max(0, Math.floor(ttlMs)) : 15 * 60 * 1000;

  function settle(id: string, value: unknown): boolean {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
    entry.resolve(value);
    return true;
  }

  function prune(now = Date.now()): number {
    let n = 0;
    for (const [id, entry] of pending) {
      if (now - entry.ts > ttlMs) {
        if (settle(id, 'reject')) n += 1; // unblock any awaiter so abandoned turns never hang
      }
    }
    return n;
  }

  return {
    request(meta = {}) {
      prune();
      const normalizedMeta = normalizeApprovalMeta(meta);
      // 容量闸门:持续高负载下丢弃最旧待决项并 resolve 为 reject,保证 map 不会无界增长。
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next().value;
        if (!oldest) break;
        settle(oldest, 'reject');
      }
      const id = `apr_${crypto.randomUUID().replace(/-/g, '')}`;
      let resolve: (value: unknown) => void = () => undefined;
      const promise = new Promise<unknown>((resolver) => { resolve = resolver; });
      const entry: PendingApproval = {
        resolve,
        meta: normalizedMeta,
        ts: Date.now(),
        expiryTimer: null,
      };
      pending.set(id, entry);
      entry.expiryTimer = setTimeout(() => {
        settle(id, 'reject');
      }, expiryDelayMs);
      const timer = entry.expiryTimer as unknown as { unref?: () => void };
      timer.unref?.();
      return { id, ready: Promise.resolve(), promise };
    },
    resolve(id, decision, context = null) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (!sameScope(entry.meta, context)) return false;
      const normalizedDecision = normalizeDecision(decision);
      if (!normalizedDecision || isQuestion(entry.meta)) return false;
      return settle(id, normalizedDecision);
    },
    resolveMany(ids, decision, context = null) {
      const uniqueIds = [...new Set(Array.isArray(ids) ? ids : [])];
      const normalizedDecision = normalizeDecision(decision);
      return uniqueIds.map((id) => {
        const entry = typeof id === 'string' ? pending.get(id) : undefined;
        if (!entry || !normalizedDecision || isQuestion(entry.meta) || !sameScope(entry.meta, context)) {
          return { id, ok: false };
        }
        return { id, ok: settle(id, normalizedDecision) };
      });
    },
    // 仅 question 请求可用自由值回答。工具/计划必须走 resolve 的枚举决策通道。
    respond(id, value, context = null) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (!sameScope(entry.meta, context)) return false;
      if (!isQuestion(entry.meta)) return false;
      return settle(id, value);
    },
    // 释放指定 runId 下全部待决请求;SSE 断开时调用,让等待中的 agent loop 解阻并干净退出。
    cancelByRun(runId, context = null) {
      if (!runId) return 0;
      let n = 0;
      for (const [id, entry] of pending) {
        if (entry.meta && entry.meta.runId === runId && sameScope(entry.meta, context)) {
          if (settle(id, 'reject')) n += 1;
        }
      }
      return n;
    },
    cancelAll(decision = 'reject') {
      for (const id of [...pending.keys()]) settle(id, decision);
    },
    pendingCount() {
      return pending.size;
    },
    prune,
  };
}
