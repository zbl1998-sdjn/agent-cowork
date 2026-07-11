// 跨实例 run 事件 pub/sub(PostgreSQL LISTEN/NOTIFY)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把本地 RunEventBus 包装成多实例可用——publish 确认 NOTIFY 成功后再写发布实例本地总线;
//       sourceId 抑制正常的发布者 LISTEN 回环；超时结果不可判定时隔离后续发布。
// 依赖:L0 util/run-events 契约；pg 运行时按需 import。后端:PostgreSQL(NOTIFY 通道)。
// 导出:PostgresEventBus(类) · createPostgresEventBus(工厂)。
import crypto from 'node:crypto';
import { RunEventBus } from '../util/run-events.js';
import type { RunEvent, RunEventHandler, RunEventPublishInput, RunEventScope, RunEventSeedInput } from '../util/run-events.js';
import {
  NotificationTimeoutError,
  errorMessage,
  publishTimeout,
  safePgIdentifier,
  withTimeout,
} from './postgres-event-bus-support.js';
import type { PgModule, PgNotification, PgNotifyClient, PgNotifyPool } from './postgres-event-bus-support.js';
export type PostgresEventBusOptions = {
  local?: RunEventBus;
  client?: PgNotifyClient | null;
  pool?: PgNotifyPool | null;
  connectionString?: string | null;
  channel?: string;
  pg?: PgModule | null;
  publishTimeoutMs?: number;
  onError?: (message: string) => void;
};

/** 跨实例 run 事件总线:本地 RunEventBus + PG NOTIFY 扇出,保持其原有订阅/回放接口。 */
export class PostgresEventBus {
  private _local: RunEventBus;
  private _client: PgNotifyClient | null;
  private _pool: PgNotifyPool | null;
  private _connectionString: string | null;
  private _pg: PgModule | null;
  private _channel: string;
  private _started: boolean;
  private _startPromise: Promise<void> | null;
  private _attachedClients: WeakSet<PgNotifyClient>;
  private _managedClients: WeakSet<PgNotifyClient>;
  private _listenerErrorVersion: number;
  private _sourceId: string;
  private _publishTimeoutMs: number;
  private _publishIndeterminate: boolean;
  private _onError: (message: string) => void;

  constructor({
    local = new RunEventBus(),
    client = null,
    pool = null,
    connectionString = null,
    channel = 'kcw_run_events',
    pg = null,
    publishTimeoutMs = 5000,
    onError = (message) => console.error('[postgres-event-bus]', message),
  }: PostgresEventBusOptions = {}) {
    this._local = local;
    this._client = client;
    this._pool = pool || client;
    this._connectionString = connectionString;
    this._pg = pg;
    this._channel = safePgIdentifier(channel);
    this._started = false;
    this._startPromise = null;
    this._attachedClients = new WeakSet();
    this._managedClients = new WeakSet();
    this._listenerErrorVersion = 0;
    this._sourceId = crypto.randomUUID();
    this._publishTimeoutMs = publishTimeout(publishTimeoutMs);
    this._publishIndeterminate = false;
    this._onError = onError;
  }

  private _reportError(message: string): void {
    try {
      this._onError(message);
    } catch (cause) {
      console.error(`[postgres-event-bus] error reporter failed: ${errorMessage(cause)}`);
    }
  }

  private _attachClientListeners(client: PgNotifyClient): void {
    if (this._attachedClients.has(client)) return;
    this._attachedClients.add(client);
    client.on('notification', (msg: PgNotification) => {
      let data: unknown;
      if (typeof msg.payload !== 'string') return;
      try {
        data = JSON.parse(msg.payload);
      } catch (cause) {
        this._reportError(`ignored malformed notification payload: ${errorMessage(cause)}`);
        return;
      }
      if (data && typeof data === 'object' && 'runId' in data && 'event' in data) {
        const remote = data as { sourceId?: unknown; runId?: unknown; event?: RunEventPublishInput; scope?: RunEventScope };
        if (remote.sourceId === this._sourceId) return;
        // 把远端事件重新注入本地总线,让本地订阅者与 replay ring 都收到。
        try {
          this._local.publish(String(remote.runId), remote.event as RunEventPublishInput, remote.scope);
        } catch (cause) {
          this._reportError(`ignored invalid notification event: ${errorMessage(cause)}`);
        }
        return;
      }
      this._reportError('ignored invalid notification envelope');
    });
    client.on('error', (cause: unknown) => {
      this._listenerErrorVersion += 1;
      this._started = false;
      if (this._managedClients.has(client) && this._client === client) {
        this._client = null;
        if (this._pool === client) this._pool = null;
      }
      this._reportError(`listener client error: ${errorMessage(cause)}`);
    });
  }

  /** 取/建专用 LISTEN 连接(pg 按需 import,缺包给出安装提示)。 */
  async _getClient(): Promise<PgNotifyClient> {
    if (this._client) {
      this._attachClientListeners(this._client);
      return this._client;
    }
    if (!this._connectionString) {
      throw new Error('PostgresEventBus: client or connectionString is required');
    }
    let pg: PgModule;
    try {
      pg = this._pg || await import('pg') as PgModule;
    } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`.");
    }
    const Client = pg.default?.Client || pg.Client;
    if (!Client) {
      throw new Error("PostgreSQL backend requires the 'pg' Client export.");
    }
    const client = new Client({ connectionString: this._connectionString });
    this._managedClients.add(client);
    if (typeof client.connect === 'function') {
      await client.connect();
    }
    this._attachClientListeners(client);
    this._client = client;
    if (!this._pool) {
      this._pool = client;
    }
    return client;
  }

  private async _startOnce(): Promise<void> {
    const client = await this._getClient();
    const listenerErrorVersion = this._listenerErrorVersion;
    await client.query(`LISTEN ${this._channel}`);
    if (listenerErrorVersion !== this._listenerErrorVersion) {
      throw new Error('PostgresEventBus.start: listener client failed while LISTEN was starting');
    }
    this._started = true;
  }

  /** 启动监听:并发调用共享同一尝试,仅在 LISTEN 成功后进入 started 状态。 */
  start(): Promise<void> {
    if (this._started) return Promise.resolve();
    if (this._startPromise) return this._startPromise;
    const attempt = this._startOnce();
    this._startPromise = attempt;
    const clearAttempt = (): void => {
      if (this._startPromise === attempt) this._startPromise = null;
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  }

  private _publishQuarantinedError(): Error {
    return new Error(
      'PostgresEventBus.publish: outbound publishing is disabled after an indeterminate '
      + 'notification outcome; recreate the event bus before publishing again',
    );
  }

  /** NOTIFY 成功后写本地事件;超时无法证明是否送达,故隔离该实例后续出站发布。 */
  async publish(runId: string, event: RunEventPublishInput, scope?: RunEventScope): Promise<RunEvent> {
    if (!runId) throw new Error('PostgresEventBus.publish: runId required');
    if (!event || !event.type) throw new Error('PostgresEventBus.publish: event.type required');
    if (this._publishIndeterminate) {
      const failure = this._publishQuarantinedError();
      this._reportError(failure.message);
      throw failure;
    }
    try {
      await withTimeout(
        (async () => {
          const client = await this._getClient();
          await (this._pool || client).query(`SELECT pg_notify($1, $2)`, [
            this._channel,
            JSON.stringify({ sourceId: this._sourceId, runId, event, scope }),
          ]);
        })(),
        this._publishTimeoutMs,
      );
    } catch (cause) {
      let failure: Error;
      if (cause instanceof NotificationTimeoutError) {
        this._publishIndeterminate = true;
        failure = new Error(
          `PostgresEventBus.publish: notification outcome is indeterminate: ${errorMessage(cause)}; `
          + 'remote delivery may have occurred; recreate the event bus before publishing again',
          { cause },
        );
      } else {
        failure = new Error(
          `PostgresEventBus.publish: notification failed: ${errorMessage(cause)}`,
          { cause },
        );
      }
      this._reportError(failure.message);
      throw failure;
    }
    if (this._publishIndeterminate) {
      const failure = this._publishQuarantinedError();
      this._reportError(failure.message);
      throw failure;
    }
    return this._local.publish(runId, event, scope);
  }

  /** 订阅某 run 的事件(透传本地总线)。 */
  subscribe(runId: string, handler: RunEventHandler, scope?: RunEventScope): () => void {
    return this._local.subscribe(runId, handler, scope);
  }
  /** 回放某 run 自 afterSeq 之后的事件(透传本地总线)。 */
  replay(runId: string, afterSeq = 0, scope?: RunEventScope): RunEvent[] {
    return this._local.replay(runId, afterSeq, scope);
  }
  /** 用持久化事件播种指定 owner 的序列号。 */
  seed(runId: string, events: RunEventSeedInput[] = [], scope?: RunEventScope): void {
    this._local.seed(runId, events, scope);
  }
  /** 返回某 run 的本地订阅者数量。 */
  subscriberCount(runId: string, scope?: RunEventScope): number {
    return this._local.subscriberCount(runId, scope);
  }
}

/** 工厂:构造跨实例 PG run 事件总线。 */
export function createPostgresEventBus(options: PostgresEventBusOptions = {}): PostgresEventBus {
  return new PostgresEventBus(options);
}
