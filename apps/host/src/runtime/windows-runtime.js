// @ts-check
import childProcess from 'node:child_process';

/**
 * @typedef {Record<string, string | undefined>} EnvLike
 * @typedef {{ status?: number | null, stdout?: unknown, stderr?: unknown }} SpawnResult
 * @typedef {(command: string, args?: readonly string[], options?: Record<string, unknown>) => SpawnResult} SpawnSyncLike
 */

/**
 * @param {EnvLike} env
 * @param {string[]} keys
 * @returns {{ key: string, value: string } | null}
 */
function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

/**
 * @param {unknown} text
 * @returns {string | undefined}
 */
function parseVcVersion(text) {
  return String(text || '').match(/\bVersion\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function registryHasInstalledFlag(text) {
  return /\bInstalled\s+REG_DWORD\s+0x1\b/i.test(String(text || ''));
}

/**
 * @param {SpawnSyncLike} spawnSync
 * @param {string} arch
 * @returns {SpawnResult}
 */
function queryVcRuntime(spawnSync, arch) {
  return spawnSync('reg', [
    'query',
    `HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\${arch}`,
    '/v',
    'Installed',
  ], { encoding: 'utf8', timeout: 1500, windowsHide: true });
}

/**
 * @param {{ env?: EnvLike, platform?: string, spawnSync?: SpawnSyncLike }} [options]
 */
export function detectVcRuntime({
  env = {},
  platform = process.platform,
  spawnSync = childProcess.spawnSync,
} = {}) {
  const configured = envValue(env, ['KCW_VC_RUNTIME_HOME', 'KCW_VC_RUNTIME_INSTALLED']);
  if (configured) {
    return { status: 'configured', source: configured.key, detail: 'VC++ 运行库已由安装器配置' };
  }
  if (platform !== 'win32') {
    return { status: 'not_applicable', detail: '仅 Windows 需要' };
  }

  try {
    for (const arch of ['x64', 'x86']) {
      const result = queryVcRuntime(spawnSync, arch);
      const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
      if (result?.status === 0 && registryHasInstalledFlag(output)) {
        const version = parseVcVersion(output);
        return {
          status: 'available',
          version,
          detail: version ? `VC++ 运行库可用:${arch} ${version}` : `VC++ 运行库可用:${arch}`,
        };
      }
    }
  } catch {
    // fall through to the same installer action as a clean miss
  }
  return { status: 'missing', detail: '未检测到 VC++ 运行库;安装器需要补齐' };
}
