// PostgreSQL 审批存储的无状态类型与校验助手(host · L1 · storage)。
import crypto from 'node:crypto';
import {
  canonicalRequiredIdentityScope,
  type IdentityScope,
} from '../security/identity-scope.js';
import { decodePostgresApprovalAnswer } from './postgres-approval-answer.js';

export type PgNotification = { channel?: string; payload?: string | null };
export type PgResult = { rows?: unknown[]; rowCount?: number | null };
export type PgClient = {
  on(event: 'notification', handler: (message: PgNotification) => void): unknown;
  query(text: string, params?: unknown[]): Promise<PgResult>;
  connect?: () => Promise<unknown>;
  end?: () => Promise<unknown>;
};
export type PgPool = {
  query(text: string, params?: unknown[]): Promise<PgResult>;
  end?: () => Promise<unknown>;
};
export type PgClientConstructor = new (options?: Record<string, unknown>) => PgClient;
export type PgModule = {
  default?: { Client?: PgClientConstructor };
  Client?: PgClientConstructor;
};
export type ApprovalMeta = {
  runId?: unknown;
  tenantId?: unknown;
  userId?: unknown;
  kind?: unknown;
  [key: string]: unknown;
};
export type ApprovalContext = { tenantId?: unknown; userId?: unknown; [key: string]: unknown };
export type ApprovalDecision = 'once' | 'session' | 'reject';
export type ApprovalChannel = 'decision' | 'answer';
export type ApprovalScope = IdentityScope;
export type PersistedApprovalRow = { status?: unknown; decision?: unknown; kind?: unknown };
export type PostgresApprovalStoreOptions = {
  client?: PgClient | null;
  pool?: PgPool | null;
  connectionString?: string | null;
  channel?: string;
  generateId?: () => string;
  pg?: PgModule | null;
  ttlMs?: number;
  maxPending?: number;
  pruneIntervalMs?: number;
  connectionTimeoutMs?: number;
  queryTimeoutMs?: number;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  onError?: (message: string) => void;
};

export function defaultApprovalId(): string {
  return `apr_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function safePgIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error('PostgresApprovalStore: invalid channel name');
  }
  return value;
}

export function requiredScope(value: ApprovalMeta | ApprovalContext | null): ApprovalScope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const tenant = Object.getOwnPropertyDescriptor(value, 'tenantId');
    const user = Object.getOwnPropertyDescriptor(value, 'userId');
    if (
      !tenant
      || !user
      || !Object.hasOwn(tenant, 'value')
      || !Object.hasOwn(user, 'value')
    ) {
      return null;
    }
    return canonicalRequiredIdentityScope(tenant.value, user.value);
  } catch {
    return null;
  }
}

export function sameScope(meta: ApprovalMeta = {}, context: ApprovalContext | null = null): boolean {
  const expected = requiredScope(meta);
  const actual = requiredScope(context);
  return !!(expected && actual && expected.tenantId === actual.tenantId && expected.userId === actual.userId);
}

export function normalizeDecision(decision: unknown): ApprovalDecision | null {
  return decision === 'once' || decision === 'session' || decision === 'reject' ? decision : null;
}

export function matchesChannel(meta: ApprovalMeta, channel: ApprovalChannel): boolean {
  return channel === 'answer' ? meta.kind === 'question' : meta.kind !== 'question';
}

export async function reconcilePersistedApproval({
  id,
  meta,
  persistence,
  read,
  isCurrent,
  settle,
  reportError,
}: {
  id: string;
  meta: ApprovalMeta;
  persistence: Promise<void>;
  read: (scope: ApprovalScope) => Promise<PersistedApprovalRow | undefined>;
  isCurrent: () => boolean;
  settle: (decision: unknown) => void;
  reportError: (message: string) => void;
}, attemptsRemaining = 3): Promise<void> {
  if (!isCurrent()) return;
  try {
    await persistence;
    const scope = requiredScope(meta);
    if (!scope) return;
    const row = await read(scope);
    if (!row) return;
    const status = String(row.status || '');
    const rowChannel: ApprovalChannel = row.kind === 'question' ? 'answer' : 'decision';
    if (!matchesChannel(meta, rowChannel)) return;
    let decision: unknown;
    let hasDecision = false;
    if (status === 'expired') {
      decision = 'reject';
      hasDecision = true;
    } else if (status === 'resolved' && rowChannel === 'answer') {
      decision = decodePostgresApprovalAnswer(row.decision);
      hasDecision = true;
    } else if (status === 'resolved') {
      const normalized = normalizeDecision(row.decision);
      if (normalized) {
        decision = normalized;
        hasDecision = true;
      }
    }
    if (!hasDecision || !isCurrent()) return;
    settle(decision);
  } catch {
    if (attemptsRemaining > 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await reconcilePersistedApproval({ id, meta, persistence, read, isCurrent, settle, reportError }, attemptsRemaining - 1);
      return;
    }
    reportError('notification reconciliation failed after bounded retries');
  }
}

export function positiveIntegerOption(
  name: string,
  value: unknown,
  fallback: number,
  { allowZero = false } = {},
): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`PostgresApprovalStore: ${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return parsed;
}
