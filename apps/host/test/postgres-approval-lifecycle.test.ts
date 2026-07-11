import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresApprovalClientBoundary } from '../src/storage/postgres-approval-client.js';
import { PostgresApprovalConnection } from '../src/storage/postgres-approval-connection.js';
import { PostgresApprovalStore } from '../src/storage/postgres-approvals.js';

type QueryResult = { rows?: Array<Record<string, unknown>>; rowCount?: number };
type FakeEvents = {
  notification: [message: { channel?: string; payload?: string | null }];
  error: [error: unknown];
  end: [];
};
type FakeEvent = keyof FakeEvents;
type FakeListener<Event extends FakeEvent> = (...args: FakeEvents[Event]) => void;

class FakeEmitter {
  private readonly _notifications = new Set<FakeListener<'notification'>>();
  private readonly _errors = new Set<FakeListener<'error'>>();
  private readonly _ends = new Set<FakeListener<'end'>>();

  private _listeners<Event extends FakeEvent>(event: Event): Set<FakeListener<Event>> {
    if (event === 'notification') {
      return this._notifications as unknown as Set<FakeListener<Event>>;
    }
    if (event === 'error') return this._errors as unknown as Set<FakeListener<Event>>;
    return this._ends as unknown as Set<FakeListener<Event>>;
  }

  on<Event extends FakeEvent>(event: Event, listener: FakeListener<Event>): this {
    this._listeners(event).add(listener);
    return this;
  }

  off<Event extends FakeEvent>(event: Event, listener: FakeListener<Event>): this {
    this._listeners(event).delete(listener);
    return this;
  }

  removeListener<Event extends FakeEvent>(event: Event, listener: FakeListener<Event>): this {
    return this.off(event, listener);
  }

  emit<Event extends FakeEvent>(event: Event, ...args: FakeEvents[Event]): boolean {
    const listeners = [...this._listeners(event)];
    if (event === 'error' && listeners.length === 0) {
      throw args[0] instanceof Error ? args[0] : new Error('Unhandled fake emitter error');
    }
    for (const listener of listeners) listener(...args);
    return listeners.length > 0;
  }

  listenerCount(event: FakeEvent): number {
    return this._listeners(event).size;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true before timeout');
    await delay(2);
  }
}

function flattenedError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map((item) => String(item))].join(' ');
  }
  const cause = error instanceof Error
    ? String((error as Error & { cause?: unknown }).cause ?? '')
    : '';
  return String(error) + ' ' + cause;
}

class SharedClient extends FakeEmitter {
  readonly queries: string[] = [];
  endCalls = 0;

  async query(text: string): Promise<QueryResult> {
    this.queries.push(text.replace(/\s+/gu, ' ').trim());
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

test('shared LISTEN clients absorb lifecycle events without ownership or reconnect', async () => {
  const client = new SharedClient();
  const errors: string[] = [];
  const store = new PostgresApprovalStore({
    client,
    onError: (message) => errors.push(message),
    pruneIntervalMs: 0,
    reconnectAttempts: 2,
    reconnectDelayMs: 1,
  });
  await store.start();

  assert.equal(client.listenerCount('notification'), 1);
  assert.equal(client.listenerCount('error'), 1);
  assert.equal(client.listenerCount('end'), 1);
  assert.doesNotThrow(() => client.emit('error', new Error('shared-client-secret')));
  client.emit('end');
  await delay(15);
  assert.equal(client.queries.filter((query) => query.startsWith('LISTEN')).length, 1);
  assert.equal(errors.some((message) => message.includes('shared-client-secret')), false);

  await store.stop();
  assert.equal(client.queries.filter((query) => query.startsWith('UNLISTEN')).length, 1);
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('end'), 0);
  assert.equal(client.endCalls, 0, 'an injected client is never owned');
});

test('stale callbacks stay inert when a shared client cannot remove listeners', async () => {
  class StickyClient extends FakeEmitter {
    constructor() {
      super();
      Object.defineProperty(this, 'off', { value: undefined });
      Object.defineProperty(this, 'removeListener', { value: undefined });
    }

    async query(): Promise<QueryResult> { return { rows: [] }; }
  }

  const client = new StickyClient();
  const notifications: string[] = [];
  const errors: string[] = [];
  const boundary = new PostgresApprovalClientBoundary({
    client,
    pool: null,
    connectionString: null,
    pg: null,
    connectionTimeoutMs: 10,
    queryTimeoutMs: 10,
  });
  const connection = new PostgresApprovalConnection({
    boundary,
    channel: 'kcw_approvals',
    reconnectAttempts: 0,
    reconnectDelayMs: 0,
    onNotification: (id) => notifications.push(id),
    onListening: () => undefined,
    onError: (message) => errors.push(message),
  });
  await connection.start();
  await connection.stop();

  assert.equal(client.listenerCount('notification'), 1, 'physical detach is unavailable');
  client.emit('notification', { channel: 'kcw_approvals', payload: '{"id":"apr_stale"}' });
  assert.doesNotThrow(() => client.emit('error', new Error('stale-secret')));
  client.emit('end');
  assert.deepEqual(notifications, []);
  assert.deepEqual(errors, []);
});

test('owned clients are released when LISTEN event registration fails', async () => {
  class RegistrationFailureClient extends FakeEmitter {
    static instance: RegistrationFailureClient | null = null;
    endCalls = 0;

    constructor() {
      super();
      RegistrationFailureClient.instance = this;
    }

    override on<Event extends FakeEvent>(event: Event, listener: FakeListener<Event>): this {
      const registered = super.on(event, listener);
      if (event === 'notification') throw new Error('registration-secret');
      return registered;
    }

    async connect(): Promise<void> { return undefined; }
    async query(): Promise<QueryResult> { return { rows: [] }; }

    async end(): Promise<void> {
      this.endCalls += 1;
      assert.equal(this.listenerCount('error'), 1, 'provisional absorber stays through end');
      this.emit('error', new Error('late-end-secret'));
    }
  }

  const errors: string[] = [];
  const store = new PostgresApprovalStore({
    connectionString: 'postgres://connection-secret/db',
    pg: { Client: RegistrationFailureClient },
    onError: (message) => errors.push(message),
    pruneIntervalMs: 0,
  });
  await assert.rejects(() => store.start(), /LISTEN client event registration failed/u);
  const client = RegistrationFailureClient.instance;
  assert.ok(client);
  assert.equal(client.endCalls, 1);
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('end'), 0);
  assert.doesNotMatch(errors.join(' '), /registration-secret|late-end-secret|connection-secret/u);
  await store.stop();
});

test('owned LISTEN failures replace the listener and query client', async () => {
  class ReconnectingClient extends FakeEmitter {
    static readonly instances: ReconnectingClient[] = [];
    readonly id: number;
    readonly queries: string[] = [];
    endCalls = 0;

    constructor(_options?: Record<string, unknown>) {
      super();
      this.id = ReconnectingClient.instances.length;
      ReconnectingClient.instances.push(this);
    }

    async connect(): Promise<void> { return undefined; }

    async query(text: string): Promise<QueryResult> {
      const sql = text.replace(/\s+/gu, ' ').trim();
      this.queries.push(sql);
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: 0 }], rowCount: 1 };
      return { rows: [] };
    }

    async end(): Promise<void> {
      this.endCalls += 1;
    }
  }

  const errors: string[] = [];
  const store = new PostgresApprovalStore({
    connectionString: 'postgres://listener-secret/db',
    pg: { Client: ReconnectingClient },
    onError: (message) => errors.push(message),
    pruneIntervalMs: 0,
    reconnectAttempts: 2,
    reconnectDelayMs: 1,
  });
  await store.start();
  const first = ReconnectingClient.instances[0];
  assert.ok(first);
  assert.doesNotThrow(() => first.emit('error', new Error('socket-secret')));
  await waitUntil(() => ReconnectingClient.instances.length === 2);
  const second = ReconnectingClient.instances[1];
  assert.ok(second);
  await waitUntil(() => second.queries.some((query) => query.startsWith('LISTEN')));

  assert.equal(first.endCalls, 1);
  assert.equal(first.listenerCount('notification'), 0);
  assert.equal(await store.pendingCount(), 0);
  assert.equal(second.queries.some((query) => query.startsWith('SELECT COUNT')), true);
  assert.equal(errors.join(' ').includes('listener-secret'), false);
  assert.equal(errors.join(' ').includes('socket-secret'), false);
  await store.stop();
  assert.equal(second.endCalls, 1);
});

test('owned reconnect catches up approvals resolved while no listener existed', async () => {
  type Row = {
    status: 'pending' | 'resolved';
    decision: unknown;
    kind: unknown;
    tenantId: unknown;
    userId: unknown;
  };
  const rows = new Map<string, Row>();
  const clients: CatchUpClient[] = [];
  const owned: CatchUpClient[] = [];
  let finishReconnect: () => void = () => undefined;
  const reconnectGate = new Promise<void>((resolve) => { finishReconnect = resolve; });

  class CatchUpClient extends FakeEmitter {
    readonly ownedIndex: number | null;
    listening = false;
    endCalls = 0;

    constructor(options?: Record<string, unknown>) {
      super();
      this.ownedIndex = typeof options?.connectionString === 'string' ? owned.length : null;
      if (this.ownedIndex !== null) owned.push(this);
      clients.push(this);
    }

    async connect(): Promise<void> {
      if (this.ownedIndex === 1) await reconnectGate;
    }

    async query(text: string, params: unknown[] = []): Promise<QueryResult> {
      const sql = text.replace(/\s+/gu, ' ').trim();
      if (sql.startsWith('LISTEN')) {
        this.listening = true;
        return { rows: [] };
      }
      if (sql.startsWith('UNLISTEN')) {
        this.listening = false;
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO pending_approvals')) {
        rows.set(String(params[0]), {
          status: 'pending',
          decision: null,
          tenantId: params[2],
          userId: params[3],
          kind: params[4],
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('WITH resolved AS')) {
        const id = String(params[0]);
        const row = rows.get(id);
        if (!row || row.status !== 'pending'
          || row.tenantId !== params[2] || row.userId !== params[3]) {
          return { rows: [], rowCount: 0 };
        }
        row.status = 'resolved';
        row.decision = params[1];
        const message = { channel: String(params[4]), payload: JSON.stringify({ id }) };
        for (const client of clients) {
          if (client.listening) client.emit('notification', message);
        }
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT status, decision, kind')) {
        const row = rows.get(String(params[0]));
        if (!row || row.tenantId !== params[1] || row.userId !== params[2]) return { rows: [] };
        return { rows: [{ status: row.status, decision: row.decision, kind: row.kind }] };
      }
      return { rows: [] };
    }

    async end(): Promise<void> {
      this.listening = false;
      this.endCalls += 1;
    }

    disconnect(): void {
      this.listening = false;
      this.emit('end');
    }
  }

  const A = new PostgresApprovalStore({
    connectionString: 'postgres://example/db',
    pg: { Client: CatchUpClient },
    pruneIntervalMs: 0,
    reconnectAttempts: 1,
    reconnectDelayMs: 0,
    onError: () => undefined,
  });
  const B = new PostgresApprovalStore({
    client: new CatchUpClient(),
    pruneIntervalMs: 0,
  });
  await A.start();
  await B.start();
  const approval = A.request({
    runId: 'run-catch-up',
    tenantId: 'tenant-a',
    userId: 'user-a',
    kind: 'tool',
  });
  await approval.ready;
  owned[0]?.disconnect();
  await waitUntil(() => owned.length === 2);
  assert.equal(await B.resolve(
    approval.id,
    'once',
    { tenantId: 'tenant-a', userId: 'user-a' },
  ), true);
  finishReconnect();

  const timedOut = Symbol('timed-out');
  const outcome = await Promise.race([
    approval.promise,
    delay(150).then(() => timedOut),
  ]);
  await A.stop();
  await B.stop();
  assert.equal(outcome, 'once');
});

test('owned reconnect attempts are bounded and report stable errors', async () => {
  class ExhaustedClient extends FakeEmitter {
    static readonly instances: ExhaustedClient[] = [];
    readonly id: number;
    endCalls = 0;

    constructor() {
      super();
      this.id = ExhaustedClient.instances.length;
      ExhaustedClient.instances.push(this);
    }

    async connect(): Promise<void> { return undefined; }

    async query(text: string): Promise<QueryResult> {
      if (text.startsWith('LISTEN') && this.id > 0) {
        throw new Error('postgres://user:password@host/db');
      }
      return { rows: [] };
    }

    async end(): Promise<void> {
      this.endCalls += 1;
    }
  }

  const errors: string[] = [];
  const store = new PostgresApprovalStore({
    connectionString: 'postgres://connection-secret/db',
    pg: { Client: ExhaustedClient },
    onError: (message) => errors.push(message),
    pruneIntervalMs: 0,
    reconnectAttempts: 2,
    reconnectDelayMs: 1,
  });
  await store.start();
  ExhaustedClient.instances[0]?.emit('end');
  await waitUntil(() => errors.some((message) => /exhausted/u.test(message)));

  assert.equal(ExhaustedClient.instances.length, 3, 'initial client plus two attempts');
  assert.equal(ExhaustedClient.instances.every((client) => client.endCalls === 1), true);
  assert.doesNotMatch(errors.join(' '), /password|connection-secret/u);
  await store.stop();
});

test('stop cancels an owned reconnect while it is backing off', async () => {
  class BackoffClient extends FakeEmitter {
    static readonly instances: BackoffClient[] = [];
    endCalls = 0;

    constructor() {
      super();
      BackoffClient.instances.push(this);
    }

    async connect(): Promise<void> { return undefined; }
    async query(): Promise<QueryResult> { return { rows: [] }; }
    async end(): Promise<void> { this.endCalls += 1; }
  }

  const store = new PostgresApprovalStore({
    connectionString: 'postgres://example/db',
    pg: { Client: BackoffClient },
    onError: () => undefined,
    pruneIntervalMs: 0,
    reconnectAttempts: 3,
    reconnectDelayMs: 60,
  });
  await store.start();
  BackoffClient.instances[0]?.emit('end');
  await waitUntil(() => BackoffClient.instances[0]?.endCalls === 1);
  await store.stop();
  await delay(70);
  assert.equal(BackoffClient.instances.length, 1);
});

test('stop bounds UNLISTEN and owned end independently, then detaches listeners', async () => {
  class HangingStopClient extends FakeEmitter {
    async connect(): Promise<void> { return undefined; }

    async query(text: string): Promise<QueryResult> {
      if (text.startsWith('UNLISTEN')) {
        return new Promise<QueryResult>(() => undefined);
      }
      return { rows: [] };
    }

    async end(): Promise<void> {
      return new Promise<void>(() => undefined);
    }
  }

  const captured: { client: HangingStopClient | null } = { client: null };
  class CapturingClient extends HangingStopClient {
    constructor() {
      super();
      captured.client = this;
    }
  }
  const store = new PostgresApprovalStore({
    connectionString: 'postgres://example/db',
    pg: { Client: CapturingClient },
    pruneIntervalMs: 0,
    queryTimeoutMs: 5,
    connectionTimeoutMs: 8,
  });
  await store.start();
  const error = await store.stop().then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof Error);
  assert.match(flattenedError(error), /UNLISTEN query timed out after 5ms/u);
  assert.match(flattenedError(error), /owned client shutdown timed out after 8ms/u);
  assert.equal(captured.client?.listenerCount('notification'), 0);
  assert.equal(captured.client?.listenerCount('error'), 0);
  assert.equal(captured.client?.listenerCount('end'), 0);
});

test('owned error absorption remains active until end completes', async () => {
  class NoisyEndClient extends FakeEmitter {
    static instance: NoisyEndClient | null = null;

    constructor() {
      super();
      NoisyEndClient.instance = this;
    }

    async connect(): Promise<void> { return undefined; }
    async query(): Promise<QueryResult> { return { rows: [] }; }

    async end(): Promise<void> {
      this.emit('error', new Error('late-end-secret'));
      await delay(1);
    }
  }

  const errors: string[] = [];
  const store = new PostgresApprovalStore({
    connectionString: 'postgres://example/db',
    pg: { Client: NoisyEndClient },
    onError: (message) => errors.push(message),
    pruneIntervalMs: 0,
  });
  await store.start();
  await store.stop();
  assert.equal(NoisyEndClient.instance?.listenerCount('error'), 0);
  assert.doesNotMatch(errors.join(' '), /late-end-secret/u);
});

test('stop generation cancels an in-flight owned start before LISTEN', async () => {
  let finishConnect: () => void = () => undefined;
  const connectGate = new Promise<void>((resolve) => { finishConnect = resolve; });

  class SlowConnectClient extends FakeEmitter {
    static instance: SlowConnectClient | null = null;
    readonly queries: string[] = [];
    endCalls = 0;

    constructor() {
      super();
      SlowConnectClient.instance = this;
    }

    async connect(): Promise<void> {
      await connectGate;
    }

    async query(text: string): Promise<QueryResult> {
      this.queries.push(text);
      return { rows: [] };
    }

    async end(): Promise<void> {
      this.endCalls += 1;
    }
  }

  const store = new PostgresApprovalStore({
    connectionString: 'postgres://example/db',
    pg: { Client: SlowConnectClient },
    pruneIntervalMs: 0,
    connectionTimeoutMs: 100,
  });
  const starting = store.start();
  await delay(0);
  const stopping = store.stop();
  finishConnect();

  const startError = await starting.then(
    () => null,
    (error: unknown) => error,
  );
  await stopping;
  assert.ok(startError instanceof Error);
  assert.match(String(startError), /stopped during start/u);
  assert.equal(SlowConnectClient.instance?.queries.some((query) => query.startsWith('LISTEN')), false);
  assert.equal(SlowConnectClient.instance?.endCalls, 1);
});

test('database failures expose stable operation errors without query data', async () => {
  class SecretQueryClient extends FakeEmitter {
    async query(text: string): Promise<QueryResult> {
      if (text.startsWith('LISTEN') || text.startsWith('UNLISTEN')) return { rows: [] };
      throw new Error('postgres://user:password@host/db answer-secret');
    }
  }
  const store = new PostgresApprovalStore({
    client: new SecretQueryClient(),
    generateId: () => 'apr_secret',
    pruneIntervalMs: 0,
  });
  await store.start();
  const approval = store.request({
    runId: 'run-secret',
    tenantId: 'tenant-a',
    userId: 'user-a',
    kind: 'question',
  });
  const error = await approval.ready.then(
    () => null,
    (cause: unknown) => cause,
  );
  assert.ok(error instanceof Error);
  assert.match(flattenedError(error), /INSERT query failed/u);
  assert.doesNotMatch(flattenedError(error), /password|answer-secret/u);
  await store.stop();
});
