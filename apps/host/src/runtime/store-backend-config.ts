// 主机状态存储后端配置(host · L2 运行时):集中解析 file/sqlite/postgres 的运行时开关。
import path from 'node:path';

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
  const storeRaw = String(config.storeBackend || process.env.KCW_STORE || 'file').toLowerCase();
  const storeBackend = resolveStoreBackend(storeRaw);
  const databaseUrl = config.databaseUrl || process.env.DATABASE_URL || null;

  return {
    storeBackend,
    databaseUrl,
    usePostgresState: storeBackend === 'postgres' && !!databaseUrl,
    sqliteDbPath: path.resolve(
      config.sqliteDbPath
        || process.env.KCW_SQLITE_PATH
        || path.join(trustedRootDefault, '.AgentCowork', 'state.sqlite'),
    ),
  };
}

function resolveStoreBackend(storeRaw: string): StoreBackend {
  if (storeRaw === 'sqlite') return 'sqlite';
  if (storeRaw === 'postgres') return 'postgres';
  return 'file';
}
