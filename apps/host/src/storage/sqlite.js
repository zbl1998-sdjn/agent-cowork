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

function runSqliteTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Prefer the original migration error.
    }
    throw err;
  }
}

export function openSqliteDatabase(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('SQLite dbPath is required');
  }
  ensureDirSync(path.dirname(dbPath));
  const Database = loadDatabaseSync();
  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
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
    const migrationSql = fs.readFileSync(file, 'utf8');
    runSqliteTransaction(db, () => {
      db.exec(migrationSql);
      insertMigration.run(id, new Date().toISOString());
    });
  }
  return db;
}

export function createSqliteDatabase(dbPath, options = {}) {
  const db = openSqliteDatabase(dbPath);
  return migrateSqliteDatabase(db, options);
}
