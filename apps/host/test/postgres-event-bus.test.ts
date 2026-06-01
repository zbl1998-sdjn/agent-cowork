import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { RunEvent } from '../src/runtime/run-events.js';
import { PostgresEventBus } from '../src/storage/postgres-event-bus.js';

type PgNotification = { channel?: string; payload?: string | null };
type PgNotificationHandler = (message: PgNotification) => void;
type PgQueryResult = { rows: unknown[] };
type MockPgClient = {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  on(evt: 'notification', handler: PgNotificationHandler): void;
};
type PgCall =
  | ['constructor', string]
  | ['connect']
  | ['on', string]
  | ['query', string, unknown[]];

const notifyParamsSchema = z.tuple([z.string(), z.string()]);
const fakeClientOptionsSchema = z.object({
  connectionString: z.string(),
}).passthrough();

function eventAt(events: readonly RunEvent[], index: number, label: string): RunEvent {
  const event = events[index];
  assert.ok(event, `${label} should exist`);
  return event;
}

function mockCluster(): { makeClient(): MockPgClient } {
  const listeners = new Set<PgNotificationHandler>();
  function makeClient(): MockPgClient {
    return {
      async query(text: string, params: unknown[] = []): Promise<PgQueryResult> {
        const t = text.replace(/\s+/g, ' ').trim();
        if (t.startsWith('SELECT pg_notify')) {
          const [channel, payload] = notifyParamsSchema.parse(params);
          for (const handler of listeners) handler({ channel, payload });
          return { rows: [] };
        }
        return { rows: [] };
      },
      on(evt: 'notification', handler: PgNotificationHandler) {
        if (evt === 'notification') listeners.add(handler);
      },
    };
  }
  return { makeClient };
}

test('cross-instance SSE: an event published on B reaches a subscriber on A', async () => {
  const cluster = mockCluster();
  const A = new PostgresEventBus({ client: cluster.makeClient() });
  const B = new PostgresEventBus({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const received: RunEvent[] = [];
  A.subscribe('run-1', (e) => received.push(e));
  await B.publish('run-1', { type: 'token', delta: '你好' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(received.length, 1, 'A received the event B published');
  const event = eventAt(received, 0, 'received event');
  assert.equal(event.type, 'token');
  assert.equal(event.delta, '你好');
});

test('published event is delivered exactly once to a same-instance subscriber', async () => {
  const cluster = mockCluster();
  const A = new PostgresEventBus({ client: cluster.makeClient() });
  await A.start();
  const got: RunEvent[] = [];
  A.subscribe('run-2', (e) => got.push(e));
  await A.publish('run-2', { type: 'done', text: 'ok' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.length, 1, 'no double-delivery (NOTIFY round-trip only)');
});

test('replay returns events the instance has observed', async () => {
  const cluster = mockCluster();
  const A = new PostgresEventBus({ client: cluster.makeClient() });
  await A.start();
  await A.publish('run-3', { type: 'token', delta: 'a' });
  await A.publish('run-3', { type: 'token', delta: 'b' });
  await new Promise((r) => setTimeout(r, 5));
  const events = A.replay('run-3', 0);
  assert.equal(events.length, 2);
});

test('connectionString creates a PG client for LISTEN and NOTIFY', async () => {
  const calls: PgCall[] = [];
  const listeners = new Set<PgNotificationHandler>();
  class FakeClient {
    constructor(options: Record<string, unknown> = {}) {
      const parsed = fakeClientOptionsSchema.parse(options);
      calls.push(['constructor', parsed.connectionString]);
    }

    async connect(): Promise<void> {
      calls.push(['connect']);
    }

    on(evt: 'notification', handler: PgNotificationHandler): void {
      calls.push(['on', evt]);
      if (evt === 'notification') listeners.add(handler);
    }

    async query(text: string, params: unknown[] = []): Promise<PgQueryResult> {
      calls.push(['query', text, params]);
      if (text.startsWith('SELECT pg_notify')) {
        const [channel, payload] = notifyParamsSchema.parse(params);
        for (const handler of listeners) handler({ channel, payload });
      }
      return { rows: [] };
    }
  }

  const bus = new PostgresEventBus({
    connectionString: 'postgres://example/db',
    pg: { Client: FakeClient },
  });
  const received: RunEvent[] = [];
  bus.subscribe('run-cs', (event) => received.push(event));
  await bus.start();
  await bus.publish('run-cs', { type: 'done', text: 'ok' });

  assert.deepEqual(calls[0], ['constructor', 'postgres://example/db']);
  assert.deepEqual(calls[1], ['connect']);
  assert.equal(calls.some((call) => call[0] === 'query' && call[1] === 'LISTEN kcw_run_events'), true);
  assert.equal(received.length, 1);
  assert.equal(eventAt(received, 0, 'received event').type, 'done');
});

test('PostgresEventBus rejects unsafe channel names', () => {
  assert.throws(
    () => new PostgresEventBus({ client: mockCluster().makeClient(), channel: 'events;select runs' }),
    /invalid channel name/,
  );
});
