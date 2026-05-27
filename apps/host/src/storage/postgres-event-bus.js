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

/** @param {unknown} value @returns {string} */
function safePgIdentifier(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresEventBus: invalid channel name');
  }
  return text;
}

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

  /** @returns {Promise<PgNotifyClient>} */
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

  /** @returns {Promise<void>} */
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
  /** @param {string} runId @param {import('../runtime/run-events.js').RunEventPublishInput} event @returns {Promise<void>} */
  publish(runId, event) {
    if (!runId) throw new Error('PostgresEventBus.publish: runId required');
    if (!event || !event.type) throw new Error('PostgresEventBus.publish: event.type required');
    return this._getClient()
      .then((client) => (this._pool || client).query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ runId, event })]))
      .then(() => {})
      .catch(() => {});
  }

  /** @param {string} runId @param {import('../runtime/run-events.js').RunEventHandler} handler @returns {() => void} */
  subscribe(runId, handler) { return this._local.subscribe(runId, handler); }
  /** @param {string} runId @param {number} [afterSeq] @returns {import('../runtime/run-events.js').RunEvent[]} */
  replay(runId, afterSeq = 0) { return this._local.replay(runId, afterSeq); }
  /** @param {string} runId @returns {number} */
  subscriberCount(runId) { return this._local.subscriberCount(runId); }
}

/** @param {PostgresEventBusOptions} [options] @returns {PostgresEventBus} */
export function createPostgresEventBus(options = {}) {
  return new PostgresEventBus(options);
}
