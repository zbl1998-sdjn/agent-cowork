import crypto from 'node:crypto';
import path from 'node:path';
import { stableJsonStringify } from '../http/request-utils.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function makeHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function scopeFromContext(context = {}) {
  return {
    tenantId: String(context.tenantId || 'tenant_local'),
    userId: String(context.userId || 'user_local'),
  };
}

function hashApproval({ kind, trustedRoot, operations }) {
  return crypto
    .createHash('sha256')
    .update(stableJsonStringify({
      kind,
      trustedRoot: path.resolve(trustedRoot),
      operations,
    }) || '{}')
    .digest('hex');
}

export function createFileOperationApprovalStore({
  ttlMs = DEFAULT_TTL_MS,
  generateId = () => `fop_${crypto.randomUUID().replace(/-/g, '')}`,
  now = () => Date.now(),
} = {}) {
  const approvals = new Map();

  function cleanup() {
    const current = now();
    for (const [id, approval] of approvals.entries()) {
      if (approval.expiresAt <= current || approval.used) {
        approvals.delete(id);
      }
    }
  }

  function issue({ kind, trustedRoot, operations, context }) {
    cleanup();
    if (!kind) throw new Error('approval kind is required');
    if (!trustedRoot) throw new Error('trustedRoot is required');
    const id = generateId();
    approvals.set(id, {
      id,
      kind,
      trustedRoot: path.resolve(trustedRoot),
      operationsHash: hashApproval({ kind, trustedRoot, operations }),
      scope: scopeFromContext(context),
      expiresAt: now() + ttlMs,
      used: false,
    });
    return id;
  }

  function consume(id, { kind, trustedRoot, operations, context }) {
    cleanup();
    if (!id || typeof id !== 'string') {
      throw makeHttpError(428, 'file operation approval is required');
    }
    const approval = approvals.get(id);
    if (!approval) {
      throw makeHttpError(403, 'file operation approval is invalid or expired');
    }
    const scope = scopeFromContext(context);
    const expectedHash = hashApproval({ kind, trustedRoot, operations });
    const expectedRoot = path.resolve(trustedRoot);
    if (
      approval.used
      || approval.kind !== kind
      || approval.trustedRoot !== expectedRoot
      || approval.operationsHash !== expectedHash
      || approval.scope.tenantId !== scope.tenantId
      || approval.scope.userId !== scope.userId
    ) {
      throw makeHttpError(403, 'file operation approval does not match this request');
    }
    approval.used = true;
    approvals.delete(id);
    return approval;
  }

  return {
    issue,
    consume,
    pendingCount: () => {
      cleanup();
      return approvals.size;
    },
  };
}
