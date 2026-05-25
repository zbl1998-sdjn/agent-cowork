import childProcess from 'node:child_process';

function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

export function detectGitRuntime({ env = {}, spawnSync = childProcess.spawnSync } = {}) {
  const configured = envValue(env, ['KCW_MINGIT_HOME', 'KCW_GIT_HOME']);
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
    return {
      status: 'available',
      version,
      detail: version ? `系统 Git 可用:${version}` : '系统 Git 可用',
    };
  }
  return { status: 'missing', detail: '未检测到 Git;可按需安装 MinGit' };
}
