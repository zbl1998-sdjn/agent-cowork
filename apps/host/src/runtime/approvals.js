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

export function createApprovalRegistry({ ttlMs = 15 * 60 * 1000, maxPending = 10000 } = {}) {
  const pending = new Map(); // id -> { resolve, meta, ts }

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
    request(meta = {}) {
      prune();
      // Capacity guard: under sustained load drop the oldest pending request
      // (resolve 'reject') so the map can never grow without bound.
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next().value;
        if (!oldest) break;
        const e = pending.get(oldest);
        pending.delete(oldest);
        e.resolve('reject');
      }
      const id = `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      pending.set(id, { resolve, meta, ts: Date.now() });
      return { id, promise };
    },
    resolve(id, decision) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      entry.resolve(DECISIONS.has(decision) ? decision : 'reject');
      return true;
    },
    // Resolve a pending request with an arbitrary free-form value (used by
    // AskUserQuestion, where the answer is the chosen option text, not a
    // fixed approve/reject decision).
    respond(id, value) {
      const entry = pending.get(id);
      if (!entry) return false;
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
    pendingCount() { return pending.size; },
    prune,
  };
}
