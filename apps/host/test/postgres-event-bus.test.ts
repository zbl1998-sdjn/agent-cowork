import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import type { RunEvent } from '../src/runtime/run-events.js';
import { runRecipe } from '../src/recipes/run-recipe.js';
import { PostgresEventBus } from '../src/storage/postgres-event-bus.js';

type PgNotification = { channel?: string; payload?: string | null };
type PgNotificationHandler = (message: PgNotification) => void;
type PgErrorHandler = (error: unknown) => void;
type PgEventHandler = PgNotificationHandler | PgErrorHandler;
type PgQueryResult = { rows: unknown[] };
type MockPgClient = {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  on(evt: 'notification' | 'error', handler: PgEventHandler): void;
};
type PgCall =
  | ['constructor', string]
  | ['connect']
  | ['on', string]
  | ['query', string, unknown[]];

const notifyParamsSchema = z.tuple([z.string(), z.string()]);
const fakeClientOptionsSchema = z.object({
  connectionString: z.string(),
}).loose();

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
      on(evt: 'notification' | 'error', handler: PgEventHandler) {
        if (evt === 'notification') listeners.add(handler as PgNotificationHandler);
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
  const published = await B.publish('run-1', { type: 'token', delta: '你好' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(received.length, 1, 'A received the event B published');
  assert.deepEqual(B.replay('run-1'), [published], 'B stores its own event exactly once');
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
  const published = await A.publish('run-2', { type: 'done', text: 'ok' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.length, 1, 'sourceId suppresses the publishing instance LISTEN loopback');
  assert.equal(published.seq, 1);
  assert.equal(published.type, 'done');
  assert.deepEqual(got[0], published);
});

test('runRecipe awaits PG publishing and persists enriched event objects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-pg-events-recipe-'));
  const bus = new PostgresEventBus({ client: mockCluster().makeClient() });
  await bus.start();

  const result = await runRecipe({
    recipeId: 'email-draft',
    trustedRoot: root,
    prompt: 'Draft a local test message',
    context: { tenantId: 'tenant_events', userId: 'user_events' },
    runStoreRoot: path.join(root, 'runs'),
    runEvents: bus,
  });

  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((event) => Number(event.seq) > 0 && typeof event.ts === 'string'));
  assert.deepEqual(
    bus.replay(result.runId, 0, { tenantId: 'tenant_events', userId: 'user_events' }),
    result.events,
  );
  const persisted = JSON.parse(fs.readFileSync(result.runPath, 'utf8')) as { events?: unknown };
  assert.deepEqual(persisted.events, result.events);
});

test('cross-instance notifications preserve tenant and user event scope', async () => {
  const cluster = mockCluster();
  const A = new PostgresEventBus({ client: cluster.makeClient() });
  const B = new PostgresEventBus({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const alice = { tenantId: 'tenant_shared', userId: 'user_alice' };
  const bob = { tenantId: 'tenant_shared', userId: 'user_bob' };
  const aliceEvents: RunEvent[] = [];
  const bobEvents: RunEvent[] = [];
  A.subscribe('run-shared', (event) => aliceEvents.push(event), alice);
  A.subscribe('run-shared', (event) => bobEvents.push(event), bob);

  await B.publish('run-shared', { type: 'private', text: 'bob only' }, bob);

  assert.equal(aliceEvents.length, 0);
  assert.equal(bobEvents.length, 1);
  assert.equal(eventAt(bobEvents, 0, 'bob event').text, 'bob only');
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

    on(evt: 'notification' | 'error', handler: PgEventHandler): void {
      calls.push(['on', evt]);
      if (evt === 'notification') listeners.add(handler as PgNotificationHandler);
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

test('start retries LISTEN after the first attempt fails without duplicating listeners', async () => {
  let listenAttempts = 0;
  let notificationListeners = 0;
  let errorListeners = 0;
  const client: MockPgClient = {
    async query(text: string): Promise<PgQueryResult> {
      if (!text.startsWith('LISTEN')) return { rows: [] };
      listenAttempts += 1;
      if (listenAttempts === 1) throw new Error('listener unavailable');
      return { rows: [] };
    },
    on(event) {
      if (event === 'notification') notificationListeners += 1;
      if (event === 'error') errorListeners += 1;
    },
  };
  const bus = new PostgresEventBus({ client });

  await assert.rejects(() => bus.start(), /listener unavailable/i);
  await bus.start();

  assert.equal(listenAttempts, 2);
  assert.equal(notificationListeners, 1);
  assert.equal(errorListeners, 1);
});

test('concurrent start calls return and await the same LISTEN attempt', async () => {
  let listenAttempts = 0;
  let releaseListen: ((result: PgQueryResult) => void) | undefined;
  const listenPending = new Promise<PgQueryResult>((resolve) => {
    releaseListen = resolve;
  });
  const client: MockPgClient = {
    query(text: string): Promise<PgQueryResult> {
      if (!text.startsWith('LISTEN')) return Promise.resolve({ rows: [] });
      listenAttempts += 1;
      return listenPending;
    },
    on() { return undefined; },
  };
  const bus = new PostgresEventBus({ client });

  const first = bus.start();
  const second = bus.start();

  assert.equal(second, first, 'concurrent callers must share the in-flight start promise');
  await Promise.resolve();
  assert.equal(listenAttempts, 1);
  releaseListen?.({ rows: [] });
  await Promise.all([first, second]);
});

test('listener client errors are reported explicitly through onError', async () => {
  const errors: string[] = [];
  let emitClientError: PgErrorHandler | undefined;
  const client: MockPgClient = {
    async query(): Promise<PgQueryResult> { return { rows: [] }; },
    on(event, handler) {
      if (event === 'error') emitClientError = handler as PgErrorHandler;
    },
  };
  const bus = new PostgresEventBus({ client, onError: (message) => errors.push(message) });
  await bus.start();
  assert.ok(emitClientError, 'client error listener should be registered');

  emitClientError(new Error('listener connection lost'));

  assert.deepEqual(errors, ['listener client error: listener connection lost']);
});

test('publish rejects and reports a NOTIFY failure without storing a local fake success', async () => {
  const errors: string[] = [];
  const client: MockPgClient = {
    async query(text: string): Promise<PgQueryResult> {
      if (text.startsWith('LISTEN')) return { rows: [] };
      throw new Error('notify offline');
    },
    on() { return undefined; },
  };
  const bus = new PostgresEventBus({
    client,
    publishTimeoutMs: 50,
    onError: (message) => errors.push(message),
  });
  await bus.start();

  await assert.rejects(
    () => bus.publish('run-notify-fail', { type: 'done' }),
    /notification failed.*notify offline/i,
  );
  assert.deepEqual(bus.replay('run-notify-fail'), []);
  assert.equal(errors.length, 1);
  assert.match(errors[0] || '', /notification failed.*notify offline/i);
});

test('publish timeout reports an indeterminate outcome and fail-closes later publishes', async () => {
  const errors: string[] = [];
  let notifyQueries = 0;
  let completeLateNotify: ((result: PgQueryResult) => void) | undefined;
  const client: MockPgClient = {
    query(text: string): Promise<PgQueryResult> {
      if (text.startsWith('LISTEN')) return Promise.resolve({ rows: [] });
      notifyQueries += 1;
      return new Promise<PgQueryResult>((resolve) => {
        completeLateNotify = resolve;
      });
    },
    on() { return undefined; },
  };
  const bus = new PostgresEventBus({
    client,
    publishTimeoutMs: 10,
    onError: (message) => errors.push(message),
  });
  await bus.start();

  await assert.rejects(
    () => bus.publish('run-notify-timeout', { type: 'done' }),
    /outcome is indeterminate.*remote delivery may have occurred.*recreate/i,
  );
  assert.deepEqual(bus.replay('run-notify-timeout'), []);
  assert.equal(errors.length, 1);
  assert.equal(notifyQueries, 1);

  await assert.rejects(
    () => bus.publish('run-after-timeout', { type: 'done' }),
    /outbound publishing is disabled.*recreate/i,
  );
  assert.equal(notifyQueries, 1, 'a quarantined bus must not issue another notification');

  completeLateNotify?.({ rows: [] });
  await Promise.resolve();
  assert.deepEqual(bus.replay('run-notify-timeout'), []);
});

test('listener reports malformed payloads and invalid remote events without publishing them', async () => {
  const errors: string[] = [];
  let notification: PgNotificationHandler | undefined;
  const client: MockPgClient = {
    async query(): Promise<PgQueryResult> { return { rows: [] }; },
    on(event, handler) {
      if (event === 'notification') notification = handler as PgNotificationHandler;
    },
  };
  const bus = new PostgresEventBus({ client, onError: (message) => errors.push(message) });
  await bus.start();
  assert.ok(notification, 'notification listener should be registered');

  notification({ payload: null });
  notification({ payload: '{not-json' });
  notification({ payload: JSON.stringify({ runId: 'run-invalid' }) });
  notification({ payload: JSON.stringify({ runId: 'run-invalid', event: {} }) });

  assert.equal(errors.length, 3);
  assert.match(errors[0] || '', /malformed notification payload/i);
  assert.match(errors[1] || '', /invalid notification envelope/i);
  assert.match(errors[2] || '', /invalid notification event/i);
  assert.deepEqual(bus.replay('run-invalid'), []);
});

test('PostgresEventBus rejects unsafe channel names', () => {
  assert.throws(
    () => new PostgresEventBus({ client: mockCluster().makeClient(), channel: 'events;select runs' }),
    /invalid channel name/,
  );
});
