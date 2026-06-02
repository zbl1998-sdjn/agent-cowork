// SQLite 数据库的打开与迁移(单机后端基座)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:基于 node:sqlite 打开数据库(开 WAL/外键/busy_timeout),并按 schema_migrations
//       逐条事务化执行迁移;迁移取自 migrations/ 目录,目录为空时回落内置 EMBEDDED 建表。
// 依赖:仅标准库(fs/path/module/url,node:sqlite 按需 require)。后端:SQLite(单机)。
// 导出:openSqliteDatabase · migrateSqliteDatabase · createSqliteDatabase。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const storageDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(storageDir, 'migrations');

export type SqliteStatement = {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes?: number };
  all(...params: unknown[]): unknown[];
};
export type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
};
type MigrationEntry = { id: string; sql?: string; readSql: () => string };
export type MigrationOptions = { migrationsPath?: string; useEmbeddedMigrations?: boolean | null };

let DatabaseSync: null | (new (dbPath: string) => SqliteDatabase) = null;

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

/** 懒加载并缓存 node:sqlite 的 DatabaseSync 构造器。 */
function loadDatabaseSync(): new (dbPath: string) => SqliteDatabase {
  if (!DatabaseSync) {
    const sqliteModule = require('node:sqlite') as { DatabaseSync: new (dbPath: string) => SqliteDatabase };
    DatabaseSync = sqliteModule.DatabaseSync;
  }
  return DatabaseSync;
}

/** 递归创建目录并返回其路径。 */
function ensureDirSync(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 列出迁移目录中形如 NNNN_*.sql 的文件,按名排序返回绝对路径。 */
function listMigrationFiles(dir = migrationsDir): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * 汇总迁移条目:优先用目录中的 .sql 文件;目录为空且允许时回落内置 EMBEDDED 迁移。
 */
function listMigrationEntries(
  dir = migrationsDir,
  { useEmbeddedMigrations = false }: { useEmbeddedMigrations?: boolean } = {},
): MigrationEntry[] {
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

/** 打开 SQLite 数据库并设好 PRAGMA(外键/WAL/busy_timeout);不支持 WAL 时优雅降级。 */
export function openSqliteDatabase(dbPath: string): SqliteDatabase {
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

/**
 * 按 schema_migrations 表幂等地逐条执行迁移,每条在独立事务里运行,失败回滚并抛原始错误。
 */
export function migrateSqliteDatabase(
  db: SqliteDatabase,
  { migrationsPath = migrationsDir, useEmbeddedMigrations = null }: MigrationOptions = {},
): SqliteDatabase {
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

/** 便捷入口:打开数据库并立即迁移到最新 schema。 */
export function createSqliteDatabase(dbPath: string, options: MigrationOptions = {}): SqliteDatabase {
  const db = openSqliteDatabase(dbPath);
  return migrateSqliteDatabase(db, options);
}
