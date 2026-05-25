// @ts-check

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * @typedef {Error & { statusCode?: number }} HttpError
 * @typedef {{ tenantId?: unknown, userId?: unknown }} ApprovalContext
 * @typedef {{ tenantId: string, userId: string }} ApprovalScope
 * @typedef {{ connectorId: string, provider: string, scopes?: unknown }} ApprovalHashInput
 * @typedef {{ id: string, connectorId: string, provider: string, scopesHash: string, scope: ApprovalScope, expiresAt: number, used: boolean }} OAuthPermissionApproval
 * @typedef {{ ttlMs?: number, generateId?: () => string, now?: () => number }} OAuthPermissionApprovalStoreOptions
 * @typedef {{ connectorId: string, provider: string, scopes?: unknown, context?: ApprovalContext }} OAuthPermissionRequest
 */

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const record = /** @type {Record<string, unknown>} */ (value);
        const encoded = stableJsonStringify(record[key]);
        return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter(Boolean);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {number} statusCode
 * @param {string} message
 * @returns {HttpError}
 */
function makeHttpError(statusCode, message) {
  const err = /** @type {HttpError} */ (new Error(message));
  err.statusCode = statusCode;
  return err;
}

/**
 * @param {ApprovalContext} [context]
 * @returns {ApprovalScope}
 */
function scopeFromContext(context = {}) {
  return {
    tenantId: String(context.tenantId || 'tenant_local'),
    userId: String(context.userId || 'user_local'),
  };
}

/**
 * @param {ApprovalHashInput} input
 * @returns {string}
 */
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

/**
 * @param {OAuthPermissionApprovalStoreOptions} [options]
 */
export function createOAuthPermissionApprovalStore({
  ttlMs = DEFAULT_TTL_MS,
  generateId = () => `oauth_apr_${crypto.randomUUID().replace(/-/g, '')}`,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, OAuthPermissionApproval>} */
  const approvals = new Map();

  function cleanup() {
    const current = now();
    for (const [id, approval] of approvals.entries()) {
      if (approval.expiresAt <= current || approval.used) approvals.delete(id);
    }
  }

  /**
   * @param {OAuthPermissionRequest} request
   * @returns {{ id: string, expiresAt: number }}
   */
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

  /**
   * @param {unknown} id
   * @param {OAuthPermissionRequest} request
   * @returns {OAuthPermissionApproval}
   */
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
    /**
     * @returns {number}
     */
    pendingCount: () => {
      cleanup();
      return approvals.size;
    },
  };
}
