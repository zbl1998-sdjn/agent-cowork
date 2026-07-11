import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEvent } from '../src/runtime/run-events.js';
import { createPostgresEventBus, PostgresEventBus } from '../src/storage/postgres-event-bus.js';

type PgNotification = { payload?: string | null };
type PgNotificationHandler = (message: PgNotification) => void;
type PgErrorHandler = (error: unknown) => void;
type PgEventHandler = PgNotificationHandler | PgErrorHandler;
type PgQueryResult = { rows: unknown[] };
type MockPgClient = {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  on(evt: 'notification' | 'error', handler: PgEventHandler): void;
};

function passiveClient(): MockPgClient {
  return {
    async query(): Promise<PgQueryResult> {
      return { rows: [] };
    },
    on() { return undefined; },
  };
}

test('configuration failures are explicit without attempting a real PostgreSQL connection', async () => {
  await assert.rejects(
    () => new PostgresEventBus().start(),
    /client or connectionString is required/i,
  );
  await assert.rejects(
    () => new PostgresEventBus({
      connectionString: 'postgres://unused.invalid/test',
      pg: {},
    }).start(),
    /requires the 'pg' Client export/i,
  );
});

test('managed listener failure during LISTEN discards the client and retries with a fresh fake', async () => {
  const clients: FakeClient[] = [];
  const errors: string[] = [];

  class FakeClient implements MockPgClient {
    private errorHandler: PgErrorHandler | undefined;

    constructor(_options: Record<string, unknown> = {}) {
      clients.push(this);
    }

    async connect(): Promise<void> {
      return undefined;
    }

    on(event: 'notification' | 'error', handler: PgEventHandler): void {
      if (event === 'error') this.errorHandler = handler as PgErrorHandler;
    }

    async query(text: string): Promise<PgQueryResult> {
      if (text.startsWith('LISTEN') && clients.length === 1) {
        this.errorHandler?.(new Error('listener failed during LISTEN'));
      }
      return { rows: [] };
    }
  }

  const bus = new PostgresEventBus({
    connectionString: 'postgres://unused.invalid/test',
    pg: { Client: FakeClient },
    onError: (message) => errors.push(message),
  });

  await assert.rejects(
    () => bus.start(),
    /listener client failed while LISTEN was starting/i,
  );
  await bus.start();

  assert.equal(clients.length, 2, 'retry must allocate a fresh managed client');
  assert.deepEqual(errors, ['listener client error: listener failed during LISTEN']);
});

test('an in-flight publish also fails closed when another publish makes delivery indeterminate', async () => {
  let notifyQueries = 0;
  let markFirstStarted: (() => void) | undefined;
  let resolveSecondNotify: ((result: PgQueryResult) => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const pool = {
    query(): Promise<PgQueryResult> {
      notifyQueries += 1;
      if (notifyQueries === 1) {
        markFirstStarted?.();
        return new Promise<PgQueryResult>(() => undefined);
      }
      return new Promise<PgQueryResult>((resolve) => {
        resolveSecondNotify = resolve;
      });
    },
  };
  const errors: string[] = [];
  const bus = new PostgresEventBus({
    client: passiveClient(),
    pool,
    publishTimeoutMs: 25,
    onError: (message) => {
      errors.push(message);
      if (/outcome is indeterminate/i.test(message)) {
        resolveSecondNotify?.({ rows: [] });
      }
    },
  });
  await bus.start();

  const first = bus.publish('run-timeout-first', { type: 'done' });
  await firstStarted;
  const second = bus.publish('run-in-flight-second', { type: 'done' });

  await assert.rejects(() => first, /outcome is indeterminate/i);
  await assert.rejects(() => second, /outbound publishing is disabled/i);
  assert.equal(notifyQueries, 2);
  assert.deepEqual(bus.replay('run-timeout-first'), []);
  assert.deepEqual(bus.replay('run-in-flight-second'), []);
  assert.equal(errors.length, 2);
});

test('factory preserves seed sequencing and subscriber-count facade behavior', async () => {
  const bus = createPostgresEventBus({ client: passiveClient() });
  bus.seed('run-seeded', [{ seq: 7, type: 'persisted' }]);
  const received: RunEvent[] = [];
  const unsubscribe = bus.subscribe('run-seeded', (event) => received.push(event));

  assert.equal(bus.subscriberCount('run-seeded'), 1);
  await bus.start();
  const published = await bus.publish('run-seeded', { type: 'done' });
  assert.equal(published.seq, 8);
  assert.deepEqual(received, [published]);

  unsubscribe();
  assert.equal(bus.subscriberCount('run-seeded'), 0);
});

test('a failing error reporter is contained and logged without breaking notification handling', async () => {
  const logged: string[] = [];
  const originalConsoleError = console.error;
  let notification: PgNotificationHandler | undefined;
  console.error = (message?: unknown) => {
    logged.push(String(message));
  };
  try {
    const client: MockPgClient = {
      async query(): Promise<PgQueryResult> { return { rows: [] }; },
      on(event, handler) {
        if (event === 'notification') notification = handler as PgNotificationHandler;
      },
    };
    const bus = new PostgresEventBus({
      client,
      onError: () => {
        throw new Error('reporter unavailable');
      },
    });
    await bus.start();
    assert.ok(notification, 'notification listener should be registered');

    assert.doesNotThrow(() => notification?.({ payload: '{}' }));
    assert.equal(logged.length, 1);
    assert.match(logged[0] || '', /error reporter failed: reporter unavailable/i);
  } finally {
    console.error = originalConsoleError;
  }
});
