// 文件操作审批(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:对「批量文件操作」预案的审批待决登记——把 write/rename/move 预案交用户确认后再 apply;带指纹防篡改、
//       TTL 清理。是「副作用先批准」原则在文件操作上的落点。依赖:L0 request-utils + node:crypto/path。
import crypto from 'node:crypto';
import path from 'node:path';
import { stableJsonStringify } from '../http/request-utils.js';
import {
  LOCAL_IDENTITY_SCOPE,
  requireIdentityScopeFrom,
  type IdentityScope,
} from '../security/identity-scope.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type FileOperationApprovalContext = {
  tenantId?: unknown;
  userId?: unknown;
};

export type FileOperationApprovalScope = IdentityScope;

export type FileOperationApprovalRequest = {
  kind: string;
  trustedRoot: string;
  operations?: unknown;
  context?: FileOperationApprovalContext;
};

export type FileOperationApproval = {
  id: string;
  kind: string;
  trustedRoot: string;
  operationsHash: string;
  scope: FileOperationApprovalScope;
  expiresAt: number;
  used: boolean;
};

export type FileOperationApprovalStoreOptions = {
  ttlMs?: number;
  generateId?: () => string;
  now?: () => number;
};

export type FileOperationApprovalStore = {
  issue(input: FileOperationApprovalRequest): string;
  consume(id: unknown, input: FileOperationApprovalRequest): FileOperationApproval;
  pendingCount(): number;
};

function makeHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function scopeFromRequest(request: FileOperationApprovalRequest): FileOperationApprovalScope {
  const descriptor = Object.getOwnPropertyDescriptor(request, 'context');
  if (!descriptor) return LOCAL_IDENTITY_SCOPE;
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error('file operation approval identity is invalid');
  }
  return requireIdentityScopeFrom(descriptor.value, {
    label: 'file operation approval identity',
  });
}

function hashApproval({
  kind,
  trustedRoot,
  operations,
}: Pick<FileOperationApprovalRequest, 'kind' | 'trustedRoot' | 'operations'>): string {
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
}: FileOperationApprovalStoreOptions = {}): FileOperationApprovalStore {
  const approvals = new Map<string, FileOperationApproval>();

  function cleanup(): void {
    const current = now();
    for (const [id, approval] of approvals.entries()) {
      if (approval.expiresAt <= current || approval.used) {
        approvals.delete(id);
      }
    }
  }

  function issue(request: FileOperationApprovalRequest): string {
    const { kind, trustedRoot, operations } = request;
    cleanup();
    if (!kind) throw new Error('approval kind is required');
    if (!trustedRoot) throw new Error('trustedRoot is required');
    const id = generateId();
    approvals.set(id, {
      id,
      kind,
      trustedRoot: path.resolve(trustedRoot),
      operationsHash: hashApproval({ kind, trustedRoot, operations }),
      scope: scopeFromRequest(request),
      expiresAt: now() + ttlMs,
      used: false,
    });
    return id;
  }

  function consume(
    id: unknown,
    request: FileOperationApprovalRequest,
  ): FileOperationApproval {
    const { kind, trustedRoot, operations } = request;
    cleanup();
    if (!id || typeof id !== 'string') {
      throw makeHttpError(428, 'file operation approval is required');
    }
    const approval = approvals.get(id);
    if (!approval) {
      throw makeHttpError(403, 'file operation approval is invalid or expired');
    }
    const scope = scopeFromRequest(request);
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
