import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const storageDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(storageDir, 'migrations');

let DatabaseSync = null;

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

export function migrateSqliteDatabase(db, { migrationsPath = migrationsDir } = {}) {
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
  for (const file of listMigrationFiles(migrationsPath)) {
    const id = path.basename(file);
    if (hasMigration.get(id)) {
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(fs.readFileSync(file, 'utf8'));
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
