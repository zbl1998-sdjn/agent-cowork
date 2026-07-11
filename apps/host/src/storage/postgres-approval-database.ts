// PostgreSQL approval SQL boundary (host · L1 · storage).
// Client construction and LISTEN lifecycle live in sibling modules so this
// class remains a small, auditable collection of parameterized statements.
import { encodePostgresApprovalAnswer } from './postgres-approval-answer.js';
import { PostgresApprovalClientBoundary } from './postgres-approval-client.js';
import { PostgresApprovalConnection } from './postgres-approval-connection.js';
import {
  type ApprovalChannel,
  type ApprovalMeta,
  type ApprovalScope,
  type PersistedApprovalRow,
  type PostgresApprovalStoreOptions,
  safePgIdentifier,
} from './postgres-approval-support.js';

type DatabaseOptions = Pick<
  PostgresApprovalStoreOptions,
  'client' | 'pool' | 'connectionString' | 'channel' | 'pg'
> & {
  connectionTimeoutMs: number;
  queryTimeoutMs: number;
  reconnectAttempts: number;
  reconnectDelayMs: number;
  onNotification: (id: string) => void;
  onListening: () => void;
  onError: (message: string) => void;
};

export type ApprovalMutationResult = { ids: string[]; count: number };

function returnedIds(rows: unknown[] | undefined): string[] {
  const ids: string[] = [];
  for (const row of rows || []) {
    if (row === null || typeof row !== 'object') continue;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(row, 'id');
      if (descriptor && typeof descriptor.value === 'string' && descriptor.value) {
        ids.push(descriptor.value);
      }
    } catch {
      // A malformed driver row cannot become an authorization identifier.
    }
  }
  return ids;
}

function affectedCount(rowCount: unknown, fallback: number): number {
  return typeof rowCount === 'number' && Number.isSafeInteger(rowCount) && rowCount >= 0
    ? rowCount
    : fallback;
}

export class PostgresApprovalDatabase {
  private readonly _client: PostgresApprovalClientBoundary;
  private readonly _connection: PostgresApprovalConnection;
  private readonly _channel: string;

  constructor(options: DatabaseOptions) {
    this._channel = safePgIdentifier(options.channel || 'kcw_approvals');
    this._client = new PostgresApprovalClientBoundary(options);
    this._connection = new PostgresApprovalConnection({
      boundary: this._client,
      channel: this._channel,
      reconnectAttempts: options.reconnectAttempts,
      reconnectDelayMs: options.reconnectDelayMs,
      onNotification: options.onNotification,
      onListening: options.onListening,
      onError: options.onError,
    });
  }

  get channel(): string { return this._channel; }

  start(): Promise<void> {
    return this._connection.start();
  }

  stop(): Promise<void> {
    return this._connection.stop();
  }

  async insert(id: string, meta: ApprovalMeta, scope: ApprovalScope): Promise<void> {
    const result = await this._client.query(
      'INSERT',
      `INSERT INTO pending_approvals (id, run_id, tenant_id, user_id, kind, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
      [id, meta.runId || null, scope.tenantId, scope.userId, meta.kind || null],
    );
    if (affectedCount(result.rowCount, 0) !== 1) {
      throw new Error('PostgresApprovalStore: PostgreSQL did not persist the approval row');
    }
  }

  async read(id: string, scope: ApprovalScope): Promise<PersistedApprovalRow | undefined> {
    const result = await this._client.query(
      'read',
      `SELECT status, decision, kind FROM pending_approvals
       WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
      [id, scope.tenantId, scope.userId],
    );
    return (result.rows && result.rows[0]) as PersistedApprovalRow | undefined;
  }

  async resolve(
    id: string,
    decision: unknown,
    scope: ApprovalScope,
    approvalChannel: ApprovalChannel,
  ): Promise<boolean> {
    const kindClause = approvalChannel === 'answer'
      ? " AND kind='question'"
      : " AND (kind IS NULL OR kind<>'question')";
    const result = await this._client.query(
      'resolve',
      `WITH resolved AS (
         UPDATE pending_approvals SET status='resolved', decision=$2, resolved_at=NOW()
         WHERE id=$1 AND status='pending' AND tenant_id=$3 AND user_id=$4${kindClause}
         RETURNING id
       )
       SELECT id, pg_notify($5, json_build_object('id', id)::text) AS notified FROM resolved`,
      [id, decision, scope.tenantId, scope.userId, this._channel],
    );
    return affectedCount(result.rowCount, result.rows?.length || 0) > 0;
  }

  async cancelByRun(runId: unknown, scope: ApprovalScope): Promise<ApprovalMutationResult> {
    const result = await this._client.query(
      'cancel',
      `WITH cancelled AS (
         UPDATE pending_approvals
         SET status='resolved',
             decision=CASE WHEN kind='question' THEN $4 ELSE 'reject' END,
             resolved_at=NOW()
         WHERE run_id=$1 AND status='pending' AND tenant_id=$2 AND user_id=$3
         RETURNING id
       )
       SELECT id, pg_notify($5, json_build_object('id', id)::text) AS notified FROM cancelled`,
      [
        runId,
        scope.tenantId,
        scope.userId,
        encodePostgresApprovalAnswer('reject'),
        this._channel,
      ],
    );
    const ids = returnedIds(result.rows);
    return { ids, count: affectedCount(result.rowCount, ids.length) };
  }

  async pendingCount(): Promise<number> {
    const result = await this._client.query(
      'pending count',
      `SELECT COUNT(*)::int AS count FROM pending_approvals WHERE status='pending'`,
      [],
    );
    const row = result.rows?.[0];
    if (row === null || typeof row !== 'object') return 0;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(row, 'count');
      return affectedCount(descriptor?.value, 0);
    } catch {
      return 0;
    }
  }

  async prune(ttlMs: number): Promise<ApprovalMutationResult> {
    const result = await this._client.query(
      'prune',
      `WITH expired AS (
         UPDATE pending_approvals SET status='expired', decision='reject', resolved_at=NOW()
         WHERE status='pending' AND created_at < NOW() - ($1::int * INTERVAL '1 millisecond')
         RETURNING id
       )
       SELECT id, pg_notify($2, json_build_object('id', id)::text) AS notified FROM expired`,
      [ttlMs, this._channel],
    );
    const ids = returnedIds(result.rows);
    return { ids, count: affectedCount(result.rowCount, ids.length) };
  }
}
