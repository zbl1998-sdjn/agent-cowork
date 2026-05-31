// 跨实例 run 事件 pub/sub(PostgreSQL LISTEN/NOTIFY)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把本地 RunEventBus 包装成多实例可用——publish 只走 NOTIFY,发布者自己的 LISTEN
//       连接收回并注入本地总线,保证每实例本地恰好投递一次;subscribe/replay/count 透传本地。
// 依赖:runtime/run-events(L2,架构基线已显式豁免:本总线适配 runtime 的事件形状)。
//       pg 运行时按需 import。后端:PostgreSQL(NOTIFY 通道)。
// 导出:PostgresEventBus(类) · createPostgresEventBus(工厂)。
//
// Cross-instance run-event pub/sub backed by PostgreSQL LISTEN/NOTIFY.
//
// Keeps the RunEventBus surface (publish / subscribe / replay / subscriberCount)
// so it is a drop-in for multi-instance SSE: an event produced on instance A is
// NOTIFY'd and re-injected into every instance's LOCAL bus, so an SSE client
// connected to instance B receives it. Delivery goes through NOTIFY only (the
// publisher receives its own NOTIFY too), guaranteeing single local delivery.
// @ts-check
import { RunEventBus } from '../runtime/run-events.js';

/**
 * @typedef {{ payload?: string | null }} PgNotification
 * @typedef {{ on(event: 'notification', handler: (message: PgNotification) => void): unknown, query(text: string, params?: unknown[]): Promise<unknown>, connect?: () => Promise<unknown>, end?: () => Promise<unknown> }} PgNotifyClient
 * @typedef {{ query(text: string, params?: unknown[]): Promise<unknown> }} PgNotifyPool
 * @typedef {new (options?: Record<string, unknown>) => PgNotifyClient} PgNotifyClientConstructor
 * @typedef {{ default?: { Client?: PgNotifyClientConstructor }, Client?: PgNotifyClientConstructor }} PgModule
 * @typedef {{ local?: RunEventBus, client?: PgNotifyClient | null, pool?: PgNotifyPool | null, connectionString?: string | null, channel?: string, pg?: PgModule | null }} PostgresEventBusOptions
 */

/** 校验 NOTIFY 通道名合法(通道名不能参数化,需防注入)。 @param {unknown} value @returns {string} */
function safePgIdentifier(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresEventBus: invalid channel name');
  }
  return text;
}

/** 跨实例 run 事件总线:本地 RunEventBus + PG NOTIFY 扇出,保持其原有订阅/回放接口。 */
export class PostgresEventBus {
  /** @param {PostgresEventBusOptions} [options] */
  constructor({ local = new RunEventBus(), client = null, pool = null, connectionString = null, channel = 'kcw_run_events', pg = null } = {}) {
    /** @type {RunEventBus} */
    this._local = local;
    /** @type {PgNotifyClient | null} */
    this._client = client;
    /** @type {PgNotifyPool | null} */
    this._pool = pool || client;
    /** @type {string | null} */
    this._connectionString = connectionString;
    /** @type {PgModule | null} */
    this._pg = pg;
    /** @type {string} */
    this._channel = safePgIdentifier(channel);
    /** @type {boolean} */
    this._started = false;
  }

  /** 取/建专用 LISTEN 连接(pg 按需 import,缺包给出安装提示)。 @returns {Promise<PgNotifyClient>} */
  async _getClient() {
    if (this._client) return this._client;
    if (!this._connectionString) {
      throw new Error('PostgresEventBus: client or connectionString is required');
    }
    let pg;
    try {
      pg = this._pg || /** @type {PgModule} */ (await import('pg'));
    } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`.");
    }
    const Client = pg.default?.Client || pg.Client;
    if (!Client) {
      throw new Error("PostgreSQL backend requires the 'pg' Client export.");
    }
    const client = new Client({ connectionString: this._connectionString });
    if (typeof client.connect === 'function') {
      await client.connect();
    }
    this._client = client;
    if (!this._pool) {
      this._pool = client;
    }
    return client;
  }

  /** 启动监听:订阅通道,收到合法 NOTIFY 后把远端事件重新注入本地总线。 @returns {Promise<void>} */
  async start() {
    if (this._started) return;
    this._started = true;
    const client = await this._getClient();
    client.on('notification', (msg) => {
      let data;
      if (typeof msg.payload !== 'string') return;
      try { data = JSON.parse(msg.payload); } catch { return; }
      if (data && data.runId && data.event) {
        // Re-inject the remote event into the local bus -> local subscribers + replay ring.
        try { this._local.publish(String(data.runId), data.event); } catch { /* ignore */ }
      }
    });
    await client.query(`LISTEN ${this._channel}`);
  }

  // Fan out via NOTIFY only; the publisher's own LISTEN connection delivers it
  // back locally, so subscribers (here or on any instance) receive it exactly once.
  /** 仅通过 NOTIFY 扇出事件(本地由自身 LISTEN 连接收回投递)。 @param {string} runId @param {import('../runtime/run-events.js').RunEventPublishInput} event @returns {Promise<void>} */
  publish(runId, event) {
    if (!runId) throw new Error('PostgresEventBus.publish: runId required');
    if (!event || !event.type) throw new Error('PostgresEventBus.publish: event.type required');
    return this._getClient()
      .then((client) => (this._pool || client).query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ runId, event })]))
      .then(() => {})
      .catch(() => {});
  }

  /** 订阅某 run 的事件(透传本地总线)。 @param {string} runId @param {import('../runtime/run-events.js').RunEventHandler} handler @returns {() => void} */
  subscribe(runId, handler) { return this._local.subscribe(runId, handler); }
  /** 回放某 run 自 afterSeq 之后的事件(透传本地总线)。 @param {string} runId @param {number} [afterSeq] @returns {import('../runtime/run-events.js').RunEvent[]} */
  replay(runId, afterSeq = 0) { return this._local.replay(runId, afterSeq); }
  /** 返回某 run 的本地订阅者数量。 @param {string} runId @returns {number} */
  subscriberCount(runId) { return this._local.subscriberCount(runId); }
}

/** 工厂:构造跨实例 PG run 事件总线。 @param {PostgresEventBusOptions} [options] @returns {PostgresEventBus} */
export function createPostgresEventBus(options = {}) {
  return new PostgresEventBus(options);
}
