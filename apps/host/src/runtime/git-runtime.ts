// Git 运行时探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测宿主机是否安装可用的 git(版本/路径),供依赖聚合与 Git 工具能力开关。依赖:node:child_process。
// 导出:detectGitRuntime。
import childProcess from 'node:child_process';

export type EnvLike = Record<string, string | undefined>;
export type SpawnResult = { status?: number | null; stdout?: unknown; stderr?: unknown };
export type SpawnSyncLike = (command: string, args?: string[], options?: Record<string, unknown>) => SpawnResult;
export type RuntimeStatus = {
  status: 'configured' | 'available' | 'missing';
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

export function detectGitRuntime({ env = {}, spawnSync = childProcess.spawnSync }: { env?: EnvLike; spawnSync?: SpawnSyncLike } = {}): RuntimeStatus {
  const configured = envValue(env, ['ACW_MINGIT_HOME', 'KCW_MINGIT_HOME', 'ACW_GIT_HOME', 'KCW_GIT_HOME']);
  if (configured) {
    return { status: 'configured', source: configured.key, detail: 'Git 运行时路径已配置' };
  }

  let result;
  try {
    result = spawnSync('git', ['--version'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
    });
  } catch {
    return { status: 'missing', detail: '未检测到 Git;可按需安装 MinGit' };
  }

  if (result?.status === 0) {
    const text = String(result.stdout || result.stderr || '').trim();
    const version = text.match(/git version\s+([^\s]+)/i)?.[1];
    return version
      ? { status: 'available', version, detail: `系统 Git 可用:${version}` }
      : { status: 'available', detail: '系统 Git 可用' };
  }
  return { status: 'missing', detail: '未检测到 Git;可按需安装 MinGit' };
}
