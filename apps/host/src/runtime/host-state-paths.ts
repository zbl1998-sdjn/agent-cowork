// Managed host-state path resolution (host · L2 runtime).
// Explicit operator paths keep their own trust boundary; implicit .AgentCowork
// defaults are revalidated against trustedRoot every time the resolver is used.
import path from 'node:path';
import { assertTrustedPathForCreate } from '../security/path-policy.js';

type HostStatePathConfig = {
  modelConfigFile?: string;
  authDbPath?: string;
  folderGrantStorePath?: string;
};

export function createHostStatePathResolvers(
  config: HostStatePathConfig,
  trustedRoot: string,
  env: Record<string, string | undefined> = process.env,
): { modelConfigFile(): string; authDbPath(): string; folderGrantStoreFile(): string } {
  const configuredKimiConfigFile = config.modelConfigFile;
  const configuredAuthDbPath = config.authDbPath || env.KCW_AUTH_DB;
  const configuredFolderGrantStore = config.folderGrantStorePath || env.KCW_FOLDER_GRANT_STORE;
  const resolve = (configuredPath: string | undefined, leaf: string): string => (
    configuredPath
      ? path.resolve(configuredPath)
      : assertTrustedPathForCreate(
        path.join(trustedRoot, '.AgentCowork', leaf),
        trustedRoot,
      )
  );
  return {
    modelConfigFile: () => resolve(configuredKimiConfigFile, 'config.json'),
    authDbPath: () => resolve(configuredAuthDbPath, 'auth.sqlite'),
    folderGrantStoreFile: () => resolve(configuredFolderGrantStore, 'folder-grants.json'),
  };
}
