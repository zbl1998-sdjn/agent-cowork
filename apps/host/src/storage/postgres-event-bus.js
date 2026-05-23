// Cross-instance run-event pub/sub backed by PostgreSQL LISTEN/NOTIFY.
//
// Keeps the RunEventBus surface (publish / subscribe / replay / subscriberCount)
// so it is a drop-in for multi-instance SSE: an event produced on instance A is
// NOTIFY'd and re-injected into every instance's LOCAL bus, so an SSE client
// connected to instance B receives it. Delivery goes through NOTIFY only (the
// publisher receives its own NOTIFY too), guaranteeing single local delivery.
import { RunEventBus } from '../runtime/run-events.js';

export class PostgresEventBus {
  constructor({ local = new RunEventBus(), client = null, pool = null, channel = 'kcw_run_events' } = {}) {
    this._local = local;
    this._client = client;
    this._pool = pool || client;
    this._channel = channel;
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;
    this._client.on('notification', (msg) => {
      let data;
      try { data = JSON.parse(msg.payload); } catch { return; }
      if (data && data.runId && data.event) {
        // Re-inject the remote event into the local bus -> local subscribers + replay ring.
        try { this._local.publish(data.runId, data.event); } catch { /* ignore */ }
      }
    });
    await this._client.query(`LISTEN ${this._channel}`);
  }

  // Fan out via NOTIFY only; the publisher's own LISTEN connection delivers it
  // back locally, so subscribers (here or on any instance) receive it exactly once.
  publish(runId, event) {
    if (!runId) throw new Error('PostgresEventBus.publish: runId required');
    if (!event || !event.type) throw new Error('PostgresEventBus.publish: event.type required');
    return Promise.resolve(this._pool.query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ runId, event })])).catch(() => {});
  }

  subscribe(runId, handler) { return this._local.subscribe(runId, handler); }
  replay(runId, afterSeq = 0) { return this._local.replay(runId, afterSeq); }
  subscriberCount(runId) { return this._local.subscriberCount(runId); }
}

export function createPostgresEventBus(options = {}) {
  return new PostgresEventBus(options);
}
