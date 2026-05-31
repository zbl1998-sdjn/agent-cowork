// 主机状态存储后端配置(host · L2 运行时):集中解析 file/sqlite/postgres 的运行时开关。
import path from 'node:path';

/** @param {Record<string, any>} config @param {string} trustedRootDefault */
export function resolveStoreBackendConfig(config, trustedRootDefault) {
  const storeRaw = String(config.storeBackend || process.env.KCW_STORE || 'file').toLowerCase();
  const storeBackend = storeRaw === 'sqlite' ? 'sqlite' : storeRaw === 'postgres' ? 'postgres' : 'file';
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
