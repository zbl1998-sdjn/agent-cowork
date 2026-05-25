import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const storageDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(storageDir, 'migrations');

let DatabaseSync = null;

const EMBEDDED_MIGRATIONS = Object.freeze([
  {
    id: '0001_init.sql',
    sql: `
CREATE TABLE IF NOT EXISTS runs_index (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  type TEXT,
  status TEXT,
  mode TEXT,
  provider TEXT,
  recipe_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms BIGINT,
  prompt_preview TEXT,
  error TEXT,
  run_path TEXT,
  version BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_index_tenant_created_at
  ON runs_index (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  fact_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_tenant_created_at
  ON memory_facts (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_notes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  size BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  note_json TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_memory_notes_tenant_created_at
  ON memory_notes (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  cron TEXT,
  fire_at TEXT,
  next_fire_at TEXT,
  last_fired_at TEXT,
  last_run_id TEXT,
  version BIGINT NOT NULL,
  runs BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  schedule_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_tenant_created_at
  ON schedules (tenant_id, created_at DESC);
`,
  },
]);

function loadDatabaseSync() {
  if (!DatabaseSync) {
    ({ DatabaseSync } = require('node:sqlite'));
  }
  return DatabaseSync;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listMigrationFiles(dir = migrationsDir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function listMigrationEntries(dir = migrationsDir, { useEmbeddedMigrations = false } = {}) {
  const fileEntries = listMigrationFiles(dir).map((file) => ({
    id: path.basename(file),
    readSql: () => fs.readFileSync(file, 'utf8'),
  }));
  if (fileEntries.length || !useEmbeddedMigrations) {
    return fileEntries;
  }
  return EMBEDDED_MIGRATIONS.map((migration) => ({
    id: migration.id,
    readSql: () => migration.sql,
  }));
}

export function openSqliteDatabase(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('SQLite dbPath is required');
  }
  ensureDirSync(path.dirname(dbPath));
  const Database = loadDatabaseSync();
  const db = new Database(dbPath);
  // foreign_keys: integrity. WAL: concurrent readers + a single writer don't
  // block each other (much better under load). busy_timeout: wait instead of
  // immediately throwing SQLITE_BUSY when another connection holds the lock.
  db.exec('PRAGMA foreign_keys = ON');
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
  } catch {
    // Some VFS/backends don't support WAL — degrade gracefully to defaults.
  }
  return db;
}

export function migrateSqliteDatabase(db, { migrationsPath = migrationsDir, useEmbeddedMigrations = null } = {}) {
  if (!db || typeof db.exec !== 'function') {
    throw new Error('SQLite database handle is required');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const hasMigration = db.prepare('SELECT id FROM schema_migrations WHERE id = ?');
  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );
  const shouldUseEmbeddedMigrations = useEmbeddedMigrations ?? path.resolve(migrationsPath) === path.resolve(migrationsDir);
  for (const migration of listMigrationEntries(migrationsPath, { useEmbeddedMigrations: shouldUseEmbeddedMigrations })) {
    const { id } = migration;
    if (hasMigration.get(id)) {
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.readSql());
      insertMigration.run(id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure; original error is more useful
      }
      throw err;
    }
  }
  return db;
}

export function createSqliteDatabase(dbPath, options = {}) {
  const db = openSqliteDatabase(dbPath);
  return migrateSqliteDatabase(db, options);
}
