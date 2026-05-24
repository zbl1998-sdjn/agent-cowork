import crypto from 'node:crypto';
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

function approvalHash({ connectorId, provider, scopes }) {
  return crypto
    .createHash('sha256')
    .update(stableJsonStringify({
      kind: 'connector-oauth',
      connectorId,
      provider,
      scopes,
    }) || '{}')
    .digest('hex');
}

export function createOAuthPermissionApprovalStore({
  ttlMs = DEFAULT_TTL_MS,
  generateId = () => `oauth_apr_${crypto.randomUUID().replace(/-/g, '')}`,
  now = () => Date.now(),
} = {}) {
  const approvals = new Map();

  function cleanup() {
    const current = now();
    for (const [id, approval] of approvals.entries()) {
      if (approval.expiresAt <= current || approval.used) approvals.delete(id);
    }
  }

  function issue({ connectorId, provider, scopes, context }) {
    cleanup();
    const id = generateId();
    const expiresAt = now() + ttlMs;
    approvals.set(id, {
      id,
      connectorId,
      provider,
      scopesHash: approvalHash({ connectorId, provider, scopes }),
      scope: scopeFromContext(context),
      expiresAt,
      used: false,
    });
    return { id, expiresAt };
  }

  function consume(id, { connectorId, provider, scopes, context }) {
    cleanup();
    if (!id || typeof id !== 'string') {
      throw makeHttpError(428, 'OAuth permission approval is required');
    }
    const approval = approvals.get(id);
    if (!approval) {
      throw makeHttpError(403, 'OAuth permission approval is invalid or expired');
    }
    const scope = scopeFromContext(context);
    if (
      approval.used
      || approval.connectorId !== connectorId
      || approval.provider !== provider
      || approval.scopesHash !== approvalHash({ connectorId, provider, scopes })
      || approval.scope.tenantId !== scope.tenantId
      || approval.scope.userId !== scope.userId
    ) {
      throw makeHttpError(403, 'OAuth permission approval does not match this request');
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
