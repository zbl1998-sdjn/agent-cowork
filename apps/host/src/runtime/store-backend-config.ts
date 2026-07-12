// 状态存储后端配置解析(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把入参与环境变量(KCW_STORE / DATABASE_URL / KCW_SQLITE_PATH)归一化为后端
//       选择(file/sqlite/postgres)、是否启用 Postgres 状态,以及解析后的 SQLite 路径。
// 依赖:node:path(路径解析)。导出:StoreBackend, StoreBackendConfigInput,
//       ResolvedStoreBackendConfig, resolveStoreBackendConfig。
import path from 'node:path';
import { assertTrustedPathForCreate } from '../security/path-policy.js';

export type StoreBackend = 'file' | 'sqlite' | 'postgres';

export type StoreBackendConfigInput = {
  storeBackend?: string | null;
  databaseUrl?: string | null;
  sqliteDbPath?: string | null;
};

export type ResolvedStoreBackendConfig = {
  storeBackend: StoreBackend;
  databaseUrl: string | null;
  usePostgresState: boolean;
  sqliteDbPath: string;
};

export function resolveStoreBackendConfig(
  config: StoreBackendConfigInput,
  trustedRootDefault: string,
): ResolvedStoreBackendConfig {
  const storeRaw = String(config.storeBackend || process.env.KCW_STORE || 'sqlite').toLowerCase();
  const storeBackend = resolveStoreBackend(storeRaw);
  const rawDatabaseUrl = config.databaseUrl || process.env.DATABASE_URL || null;
  const databaseUrl = typeof rawDatabaseUrl === 'string' && rawDatabaseUrl.trim()
    ? rawDatabaseUrl.trim()
    : null;
  if (storeBackend === 'postgres' && !databaseUrl) {
    throw new Error('KCW_STORE=postgres requires DATABASE_URL');
  }

  const configuredSqliteDbPath = config.sqliteDbPath || process.env.KCW_SQLITE_PATH;
  return {
    storeBackend,
    databaseUrl,
    usePostgresState: storeBackend === 'postgres' && !!databaseUrl,
    sqliteDbPath: configuredSqliteDbPath
      ? path.resolve(configuredSqliteDbPath)
      : assertTrustedPathForCreate(
        path.join(trustedRootDefault, '.AgentCowork', 'state.sqlite'),
        trustedRootDefault,
      ),
  };
}

function resolveStoreBackend(storeRaw: string): StoreBackend {
  if (storeRaw === 'sqlite') return 'sqlite';
  if (storeRaw === 'postgres') return 'postgres';
  return 'file';
}
