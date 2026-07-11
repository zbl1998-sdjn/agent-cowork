import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

import { buildPostgresMigrationPlan } from '../../apps/host/src/storage/postgres-migration-plan.js';
import { requireEphemeralPostgresUrl } from './postgres-test-url.js';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

export type EphemeralSchemaContext = {
  connectionString: string;
  schema: string;
  control: Client;
  client: Client;
};

function quotedIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error('Unsafe PostgreSQL integration identifier');
  return `"${value}"`;
}

function clientOptions(connectionString: string): Record<string, unknown> {
  return {
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  };
}

export async function createSchemaClient(
  context: Pick<EphemeralSchemaContext, 'connectionString' | 'schema'>,
): Promise<Client> {
  const client = new Client(clientOptions(context.connectionString));
  try {
    await client.connect();
    await client.query(
      `SET search_path TO ${quotedIdentifier(context.schema)}, pg_catalog`,
    );
    return client;
  } catch (error) {
    try {
      await client.end();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'PostgreSQL integration client setup and cleanup both failed',
      );
    }
    throw error;
  }
}

export async function withEphemeralSchema<T>(
  run: (context: EphemeralSchemaContext) => Promise<T>,
): Promise<T> {
  const connectionString = requireEphemeralPostgresUrl();
  const schema = `kcw_it_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const control = new Client(clientOptions(connectionString));
  let schemaCreated = false;
  let client: Client | null = null;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await control.connect();
    await control.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`);
    schemaCreated = true;
    client = await createSchemaClient({ connectionString, schema });
    outcome = {
      ok: true,
      value: await run({ connectionString, schema, control, client }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const cleanupErrors: unknown[] = [];
  if (client) {
    try { await client.end(); } catch (error) { cleanupErrors.push(error); }
  }
  if (schemaCreated) {
    try {
      await control.query(`DROP SCHEMA ${quotedIdentifier(schema)} CASCADE`);
    } catch (error) { cleanupErrors.push(error); }
  }
  try { await control.end(); } catch (error) { cleanupErrors.push(error); }

  if (!outcome.ok) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [outcome.error, ...cleanupErrors],
        'PostgreSQL integration operation and cleanup failed',
      );
    }
    throw outcome.error;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'PostgreSQL integration cleanup failed');
  }
  return outcome.value;
}

export async function applyPostgresMigrations(
  client: Client,
  { from = 1, through = Number.POSITIVE_INFINITY }: { from?: number; through?: number } = {},
): Promise<void> {
  if (!Number.isSafeInteger(from) || from < 1) {
    throw new Error('PostgreSQL integration migration start must be a positive integer');
  }
  if (through !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(through) || through < from)) {
    throw new Error('PostgreSQL integration migration end must follow its start');
  }
  const plan = buildPostgresMigrationPlan();
  const selected = plan.migrations.filter(
    (migration) => migration.sequence >= from && migration.sequence <= through,
  );
  if (selected.length === 0) throw new Error('PostgreSQL integration migration selection is empty');

  for (const migration of selected) {
    const sql = fs.readFileSync(path.join(plan.directory, migration.file), 'utf8');
    try {
      await client.query(sql);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `PostgreSQL integration failed to roll back ${migration.file}`,
        );
      }
      throw error;
    }
  }
}

export async function queryRows(
  client: Client,
  text: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(text, params);
  const rows: Array<Record<string, unknown>> = [];
  for (const row of result.rows || []) {
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

export function scopedPostgresUrl(
  context: Pick<EphemeralSchemaContext, 'connectionString' | 'schema'>,
  applicationName: string,
): string {
  if (!IDENTIFIER.test(context.schema) || !IDENTIFIER.test(applicationName)) {
    throw new Error('Unsafe PostgreSQL integration connection scope');
  }
  const url = new URL(context.connectionString);
  url.searchParams.set('options', `-csearch_path=${context.schema},pg_catalog`);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

export async function waitUntil<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`PostgreSQL integration timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
