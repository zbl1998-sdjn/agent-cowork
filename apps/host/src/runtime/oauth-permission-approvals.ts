// OAuth 权限审批(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:连接器 OAuth 授权前的「权限审批」待决登记——把待授予的权限项交给用户确认/勾选,带 TTL 清理。
//       与 approvals.js 类似但专用于连接器授权范围。依赖:node:crypto。导出:OAuth 权限审批登记表。
import crypto from 'node:crypto';
import {
  LOCAL_IDENTITY_SCOPE,
  requireIdentityScopeFrom,
  type IdentityScope,
} from '../security/identity-scope.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

type HttpError = Error & { statusCode?: number };

export type ApprovalContext = {
  tenantId?: unknown;
  userId?: unknown;
};

export type ApprovalScope = IdentityScope;

export type ApprovalHashInput = {
  connectorId: string;
  provider: string;
  scopes?: unknown;
};

export type OAuthPermissionApproval = {
  id: string;
  connectorId: string;
  provider: string;
  scopesHash: string;
  scope: ApprovalScope;
  expiresAt: number;
  used: boolean;
};

export type OAuthPermissionApprovalStoreOptions = {
  ttlMs?: number;
  generateId?: () => string;
  now?: () => number;
};

export type OAuthPermissionRequest = {
  connectorId: string;
  provider: string;
  scopes?: unknown;
  context?: ApprovalContext;
};

export type OAuthPermissionApprovalStore = {
  issue(request: OAuthPermissionRequest): { id: string; expiresAt: number };
  consume(id: unknown, request: OAuthPermissionRequest): OAuthPermissionApproval;
  pendingCount(): number;
};

function stableJsonStringify(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item) ?? 'null').join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const encoded = stableJsonStringify(record[key]);
        return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter((entry): entry is string => Boolean(entry));
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeHttpError(statusCode: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

function scopeFromRequest(request: OAuthPermissionRequest): ApprovalScope {
  const descriptor = Object.getOwnPropertyDescriptor(request, 'context');
  if (!descriptor) return LOCAL_IDENTITY_SCOPE;
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error('OAuth permission approval identity is invalid');
  }
  return requireIdentityScopeFrom(descriptor.value, {
    label: 'OAuth permission approval identity',
  });
}

function approvalHash({ connectorId, provider, scopes }: ApprovalHashInput): string {
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
}: OAuthPermissionApprovalStoreOptions = {}): OAuthPermissionApprovalStore {
  const approvals = new Map<string, OAuthPermissionApproval>();

  function cleanup(): void {
    const current = now();
    for (const [id, approval] of approvals.entries()) {
      if (approval.expiresAt <= current || approval.used) approvals.delete(id);
    }
  }

  function issue(request: OAuthPermissionRequest): {
    id: string;
    expiresAt: number;
  } {
    const { connectorId, provider, scopes } = request;
    cleanup();
    const id = generateId();
    const expiresAt = now() + ttlMs;
    approvals.set(id, {
      id,
      connectorId,
      provider,
      scopesHash: approvalHash({ connectorId, provider, scopes }),
      scope: scopeFromRequest(request),
      expiresAt,
      used: false,
    });
    return { id, expiresAt };
  }

  function consume(
    id: unknown,
    request: OAuthPermissionRequest,
  ): OAuthPermissionApproval {
    const { connectorId, provider, scopes } = request;
    cleanup();
    if (!id || typeof id !== 'string') {
      throw makeHttpError(428, 'OAuth permission approval is required');
    }
    const approval = approvals.get(id);
    if (!approval) {
      throw makeHttpError(403, 'OAuth permission approval is invalid or expired');
    }
    const scope = scopeFromRequest(request);
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
