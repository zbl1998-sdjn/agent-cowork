// 内置 Python 探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测随包内置 Python 是否就绪。优先认桌面外壳(src-tauri/sidecar.rs)启动 host 时
//       注入的 ACW_EMBEDDED_PYTHON / ACW_PYTHON_HOME(兼容旧名 KCW_EMBEDDED_PYTHON /
//       KCW_PYTHON_HOME)环境变量;env 缺失时回落到「host 可执行
//       文件同级 python-embedded/ 目录」实地探测——安装版里 python-embedded/ 与
//       agent-cowork-host.exe 同目录(见 tauri.conf.json bundle.resources 与 sidecar.rs),
//       不能仅因某次启动没设 env 就误报「缺失」(dogfood 2026-07-09 发现的面板误报)。
// 依赖:node:fs/path。导出:detectEmbeddedPython。
import fs from 'node:fs';
import path from 'node:path';

const EMBEDDED_DIR = 'python-embedded';
type PathFlavor = Pick<typeof path, 'dirname' | 'join'>;
const pathFlavors = path as typeof path & { win32: PathFlavor; posix: PathFlavor };

export type EnvLike = Record<string, string | undefined>;
export type ExistsFs = { existsSync(path: string): boolean };
export type EmbeddedPythonStatus = {
  status: 'configured' | 'available' | 'missing';
  source?: string;
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

/** 各平台随包 Python 解释器相对 python-embedded 根目录的候选相对路径。 */
function pythonExeRelPaths(platform: string): string[] {
  return platform === 'win32'
    ? ['python.exe']
    : ['bin/python3', 'bin/python', 'python3', 'python'];
}

function exists(fsImpl: ExistsFs, target: string): boolean {
  try {
    return fsImpl.existsSync(target);
  } catch {
    return false;
  }
}

export function detectEmbeddedPython(
  {
    env = {},
    execPath = process.execPath,
    platform = process.platform,
    fsImpl = fs,
  }: { env?: EnvLike; execPath?: string; platform?: string; fsImpl?: ExistsFs } = {},
): EmbeddedPythonStatus {
  const configured = envValue(env, ['ACW_EMBEDDED_PYTHON', 'KCW_EMBEDDED_PYTHON', 'ACW_PYTHON_HOME', 'KCW_PYTHON_HOME']);
  if (configured) {
    return { status: 'configured', source: configured.key, detail: '内置 Python 路径已配置' };
  }
  // env 未设:实地探测 host 可执行文件同级的随包 python-embedded 目录(安装版布局)。
  // 测试与跨平台打包检查可注入目标平台;路径语义必须跟随目标平台,不能跟随当前 Node 宿主。
  const platformPath = platform === 'win32' ? pathFlavors.win32 : pathFlavors.posix;
  const execDir = platformPath.dirname(String(execPath || ''));
  if (execDir && execDir !== '.') {
    const home = platformPath.join(execDir, EMBEDDED_DIR);
    for (const rel of pythonExeRelPaths(platform)) {
      if (exists(fsImpl, platformPath.join(home, rel))) {
        return { status: 'available', detail: '随包内置 Python(安装目录)' };
      }
    }
  }
  return { status: 'missing', detail: '未配置内置 Python 路径,也未在安装目录探测到 python-embedded' };
}
