// PostgreSQL approval client boundary (host · L1 · storage).
// Owns client construction, stable operation errors, query deadlines, and
// closing only clients created from this store's connectionString.
import type {
  PgClient,
  PgModule,
  PgPool,
  PgResult,
  PostgresApprovalStoreOptions,
} from './postgres-approval-support.js';

type ClientOptions = Pick<
  PostgresApprovalStoreOptions,
  'client' | 'pool' | 'connectionString' | 'pg'
> & {
  connectionTimeoutMs: number;
  queryTimeoutMs: number;
};

type ErrorEventClient = PgClient & {
  on(event: 'error', handler: () => void): unknown;
  off?(event: 'error', handler: () => void): unknown;
  removeListener?(event: 'error', handler: () => void): unknown;
};

class StablePostgresApprovalError extends Error {}

function stableError(message: string): StablePostgresApprovalError {
  return new StablePostgresApprovalError(`PostgresApprovalStore: ${message}`);
}

async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(stableError(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function removeErrorListener(client: PgClient, handler: () => void): void {
  const eventClient = client as ErrorEventClient;
  try {
    if (eventClient.off) eventClient.off('error', handler);
    else eventClient.removeListener?.('error', handler);
  } catch {
    // A broken emitter is already outside the usable client contract.
  }
}

export class PostgresApprovalClientBoundary {
  private readonly _injectedClient: PgClient | null;
  private readonly _injectedPool: PgPool | null;
  private readonly _connectionString: string | null;
  private readonly _pg: PgModule | null;
  private readonly _connectionTimeoutMs: number;
  private readonly _queryTimeoutMs: number;
  private readonly _provisionalAbsorbers = new WeakMap<PgClient, () => void>();
  private _ownedClient: PgClient | null = null;
  private _creating: Promise<PgClient> | null = null;
  private _disabled = false;

  constructor(options: ClientOptions) {
    this._injectedClient = options.client || null;
    this._injectedPool = options.pool || null;
    this._connectionString = typeof options.connectionString === 'string'
      && options.connectionString.length > 0
      ? options.connectionString
      : null;
    this._pg = options.pg || null;
    this._connectionTimeoutMs = options.connectionTimeoutMs;
    this._queryTimeoutMs = options.queryTimeoutMs;
  }

  owns(client: PgClient): boolean {
    return !this._injectedClient && this._ownedClient === client;
  }

  private _attachProvisionalAbsorber(client: PgClient): void {
    const absorber = () => undefined;
    try {
      (client as ErrorEventClient).on('error', absorber);
      this._provisionalAbsorbers.set(client, absorber);
    } catch {
      throw stableError('PostgreSQL client event registration failed');
    }
  }

  handoffErrorAbsorber(client: PgClient): void {
    const absorber = this._provisionalAbsorbers.get(client);
    if (!absorber) return;
    this._provisionalAbsorbers.delete(client);
    removeErrorListener(client, absorber);
  }

  private async _loadPg(): Promise<PgModule> {
    if (this._pg) return this._pg;
    try {
      return await import('pg') as PgModule;
    } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`.");
    }
  }

  private async _createOwnedClient(): Promise<PgClient> {
    if (!this._connectionString) {
      throw stableError('client or connectionString is required');
    }
    const pg = await this._loadPg();
    const Client = pg.default?.Client || pg.Client;
    if (!Client) throw stableError("PostgreSQL backend requires the 'pg' Client export");
    let client: PgClient | null = null;
    try {
      client = new Client({
        connectionString: this._connectionString,
        connectionTimeoutMillis: this._connectionTimeoutMs,
        query_timeout: this._queryTimeoutMs,
        statement_timeout: this._queryTimeoutMs,
      });
      this._attachProvisionalAbsorber(client);
      if (client.connect) {
        await withTimeout(
          'connection',
          this._connectionTimeoutMs,
          () => client?.connect?.() as Promise<unknown>,
        );
      }
      return client;
    } catch (error) {
      if (typeof client?.end === 'function') {
        try {
          await withTimeout(
            'failed client shutdown',
            this._connectionTimeoutMs,
            () => client?.end?.() as Promise<unknown>,
          );
        } catch {
          // The stable connection failure remains the primary error.
        }
      }
      const absorber = client ? this._provisionalAbsorbers.get(client) : null;
      if (client && absorber) removeErrorListener(client, absorber);
      if (error instanceof StablePostgresApprovalError) throw error;
      throw stableError('PostgreSQL connection failed');
    }
  }

  async listenerClient(): Promise<PgClient> {
    if (this._disabled) throw stableError('client boundary is stopped');
    if (this._injectedClient) return this._injectedClient;
    if (this._ownedClient) return this._ownedClient;
    if (this._creating) return this._creating;
    const creating = this._createOwnedClient();
    this._creating = creating;
    try {
      const client = await creating;
      if (this._disabled) {
        this._ownedClient = client;
        await this.releaseOwnedClient(client);
        throw stableError('client boundary is stopped');
      }
      this._ownedClient = client;
      return client;
    } finally {
      if (this._creating === creating) this._creating = null;
    }
  }

  private async _queryTarget(
    target: PgPool,
    operation: string,
    text: string,
    params?: unknown[],
  ): Promise<PgResult> {
    try {
      return await withTimeout(
        `${operation} query`,
        this._queryTimeoutMs,
        () => target.query(text, params),
      );
    } catch (error) {
      if (error instanceof StablePostgresApprovalError) throw error;
      throw stableError(`${operation} query failed`);
    }
  }

  queryClient(
    client: PgClient,
    operation: string,
    text: string,
    params?: unknown[],
  ): Promise<PgResult> {
    return this._queryTarget(client, operation, text, params);
  }

  async query(operation: string, text: string, params?: unknown[]): Promise<PgResult> {
    if (this._disabled) throw stableError('client boundary is stopped');
    const target = this._injectedPool
      || this._injectedClient
      || await this.listenerClient();
    return this._queryTarget(target, operation, text, params);
  }

  async releaseOwnedClient(client: PgClient): Promise<void> {
    if (this._injectedClient || this._ownedClient !== client) return;
    this._ownedClient = null;
    const absorber = this._provisionalAbsorbers.get(client);
    try {
      if (client.end) {
        await withTimeout(
          'owned client shutdown',
          this._connectionTimeoutMs,
          () => client.end?.() as Promise<unknown>,
        );
      }
    } catch (error) {
      if (error instanceof StablePostgresApprovalError) throw error;
      throw stableError('owned client shutdown failed');
    } finally {
      if (absorber) {
        this._provisionalAbsorbers.delete(client);
        removeErrorListener(client, absorber);
      }
    }
  }

  disable(): void {
    this._disabled = true;
  }
}
