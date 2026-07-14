// Windows 运行库探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测 Windows 上的 VC++ 运行库(VC Redist)等系统依赖是否就绪,供需要它的原生组件能力开关。依赖:node:child_process。
// 导出:detectVcRuntime。
import childProcess from 'node:child_process';

export type EnvLike = Record<string, string | undefined>;
export type SpawnResult = { status?: number | null; stdout?: unknown; stderr?: unknown };
export type SpawnSyncLike = (command: string, args?: readonly string[], options?: Record<string, unknown>) => SpawnResult;
export type VcRuntimeStatus = {
  status: 'configured' | 'available' | 'missing' | 'not_applicable';
  source?: string;
  version?: string;
  detail: string;
};

function envValue(env: EnvLike, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

function parseVcVersion(text: unknown): string | undefined {
  return String(text || '').match(/\bVersion\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
}

function registryHasInstalledFlag(text: unknown): boolean {
  return /\bInstalled\s+REG_DWORD\s+0x1\b/i.test(String(text || ''));
}

function queryVcRuntime(spawnSync: SpawnSyncLike, arch: string): SpawnResult {
  return spawnSync('reg', [
    'query',
    `HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\${arch}`,
    '/v',
    'Installed',
  ], { encoding: 'utf8', timeout: 1500, windowsHide: true });
}

export function detectVcRuntime({
  env = {},
  platform = process.platform,
  spawnSync = childProcess.spawnSync,
}: { env?: EnvLike; platform?: string; spawnSync?: SpawnSyncLike } = {}): VcRuntimeStatus {
  const configured = envValue(env, ['ACW_VC_RUNTIME_HOME', 'KCW_VC_RUNTIME_HOME', 'ACW_VC_RUNTIME_INSTALLED', 'KCW_VC_RUNTIME_INSTALLED']);
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
        return version
          ? { status: 'available', version, detail: `VC++ 运行库可用:${arch} ${version}` }
          : { status: 'available', detail: `VC++ 运行库可用:${arch}` };
      }
    }
  } catch {
    // fall through to the same installer action as a clean miss
  }
  return { status: 'missing', detail: '未检测到 VC++ 运行库;安装器需要补齐' };
}
