// @ts-check
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

const DECISIONS = new Set(['once', 'session', 'reject']);

/**
 * @typedef {'once' | 'session' | 'reject'} ApprovalDecision
 * @typedef {{ tenantId?: string, userId?: string, runId?: string, [key: string]: unknown }} ApprovalMeta
 * @typedef {{ tenantId?: string, userId?: string }} ApprovalContext
 * @typedef {{ resolve: (value: unknown) => void, meta: ApprovalMeta, ts: number }} PendingApproval
 * @typedef {{ ttlMs?: number, maxPending?: number }} ApprovalRegistryOptions
 * @typedef {{
 *   request(meta?: ApprovalMeta): { id: string, promise: Promise<unknown> },
 *   resolve(id: string, decision: unknown, context?: ApprovalContext | null): boolean,
 *   resolveMany(ids: unknown, decision: unknown, context?: ApprovalContext | null): { id: unknown, ok: boolean }[],
 *   respond(id: string, value: unknown, context?: ApprovalContext | null): boolean,
 *   cancelByRun(runId: unknown, decision?: unknown): number,
 *   cancelAll(decision?: unknown): void,
 *   pendingCount(): number,
 *   prune(now?: number): number
 * }} ApprovalRegistry
 */

/**
 * @param {ApprovalMeta} [meta]
 * @param {ApprovalContext | null} [context]
 * @returns {boolean}
 */
function sameScope(meta = {}, context = null) {
  const tenantId = meta.tenantId || '';
  const userId = meta.userId || '';
  if (!tenantId && !userId) return true;
  if (!context) return false;
  if (tenantId && context.tenantId !== tenantId) return false;
  if (userId && context.userId !== userId) return false;
  return true;
}

/** @param {unknown} decision @returns {ApprovalDecision} */
function normalizeDecision(decision) {
  return typeof decision === 'string' && DECISIONS.has(decision)
    ? /** @type {ApprovalDecision} */ (decision)
    : 'reject';
}

/**
 * @param {ApprovalRegistryOptions} [options]
 * @returns {ApprovalRegistry}
 */
export function createApprovalRegistry({ ttlMs = 15 * 60 * 1000, maxPending = 10000 } = {}) {
  /** @type {Map<string, PendingApproval>} */
  const pending = new Map(); // id -> { resolve, meta, ts }

  /** @param {number} [now] */
  function prune(now = Date.now()) {
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
    /** @param {ApprovalMeta} [meta] */
    request(meta = {}) {
      prune();
      // Capacity guard: under sustained load drop the oldest pending request
      // (resolve 'reject') so the map can never grow without bound.
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next().value;
        if (!oldest) break;
        const e = pending.get(oldest);
        pending.delete(oldest);
        if (e) e.resolve('reject');
      }
      const id = `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      /** @type {(value: unknown) => void} */
      let resolve = () => {};
      const promise = new Promise((r) => { resolve = r; });
      pending.set(id, { resolve, meta, ts: Date.now() });
      return { id, promise };
    },
    /** @param {string} id @param {unknown} decision @param {ApprovalContext | null} [context] */
    resolve(id, decision, context = null) {
      const entry = pending.get(id);
      if (!entry) return false;
      if (!sameScope(entry.meta, context)) return false;
      pending.delete(id);
      entry.resolve(normalizeDecision(decision));
      return true;
    },
    /** @param {unknown} ids @param {unknown} decision @param {ApprovalContext | null} [context] */
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
    /** @param {string} id @param {unknown} value @param {ApprovalContext | null} [context] */
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
    /** @param {unknown} runId @param {unknown} [decision] */
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
    /** @param {unknown} [decision] */
    cancelAll(decision = 'reject') {
      for (const [id, entry] of pending) {
        entry.resolve(decision);
        pending.delete(id);
      }
    },
    pendingCount() { return pending.size; },
    prune,
  };
}
