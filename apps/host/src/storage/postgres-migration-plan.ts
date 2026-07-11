// PostgreSQL 迁移清单(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:离线发现、校验并摘要迁移文件，供人工审批数据库变更前审阅。
// 安全边界:本模块只读本地 SQL；不读取 DATABASE_URL，不创建客户端，也不连接数据库。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHED_POSTGRES_MIGRATION_SHA256 } from './postgres-migration-baseline.js';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('./migrations-postgres/', import.meta.url));
const MIGRATION_NAME = /^(\d{4})_[a-z0-9][a-z0-9_]*\.sql$/;

export type PostgresMigrationPlanEntry = {
  sequence: number;
  file: string;
  bytes: number;
  sha256: string;
};

export type PostgresMigrationPlan = {
  mode: 'plan-only';
  databaseConnected: false;
  directory: string;
  migrations: PostgresMigrationPlanEntry[];
};

export function validatePostgresMigrationNames(names: string[]): string[] {
  const ordered = [...names].sort((left, right) => left.localeCompare(right, 'en'));
  if (ordered.length === 0) {
    throw new Error('PostgreSQL migration plan is empty');
  }
  for (const [index, name] of ordered.entries()) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      throw new Error(`Invalid PostgreSQL migration filename: ${name}`);
    }
    const expected = String(index + 1).padStart(4, '0');
    if (match[1] !== expected) {
      throw new Error(`Expected migration ${expected}, found ${name}`);
    }
  }
  return ordered;
}

export function buildPostgresMigrationPlan(directory = DEFAULT_DIRECTORY): PostgresMigrationPlan {
  const resolvedDirectory = path.resolve(directory);
  const names = fs.readdirSync(resolvedDirectory).filter((name) => name.toLowerCase().endsWith('.sql'));
  const ordered = validatePostgresMigrationNames(names);
  const migrations = ordered.map((file, index) => {
    const contents = fs.readFileSync(path.join(resolvedDirectory, file));
    if (contents.length === 0) {
      throw new Error(`PostgreSQL migration is empty: ${file}`);
    }
    return {
      sequence: index + 1,
      file,
      bytes: contents.length,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    };
  });
  for (const [file, expectedSha256] of Object.entries(PUBLISHED_POSTGRES_MIGRATION_SHA256)) {
    const migration = migrations.find((entry) => entry.file === file);
    if (!migration) {
      throw new Error(`Published PostgreSQL migration is missing: ${file}`);
    }
    if (migration.sha256 !== expectedSha256) {
      throw new Error(`Published PostgreSQL migration checksum mismatch: ${file}`);
    }
  }
  return {
    mode: 'plan-only',
    databaseConnected: false,
    directory: resolvedDirectory,
    migrations,
  };
}
