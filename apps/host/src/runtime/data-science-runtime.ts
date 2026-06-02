// 数据科学运行时探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测数据科学运行时(内置/系统 Python 及 pandas/numpy 等)是否就绪,供数据分析类能力开关。依赖:node:fs/path。
// 导出:detectDataScienceRuntime。
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_PACKAGES = ['pandas', 'numpy', 'matplotlib'];

export type EnvLike = Record<string, string | undefined>;
export type ExistsFs = { existsSync(path: string): boolean };
export type DataScienceRuntimeStatus = {
  status: 'available' | 'missing';
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

function exists(fsImpl: ExistsFs, target: string): boolean {
  try {
    return fsImpl.existsSync(target);
  } catch {
    return false;
  }
}

function hasPackageMarkers(root: string, fsImpl: ExistsFs): boolean {
  const sitePackages = [
    path.join(root, 'Lib', 'site-packages'),
    path.join(root, 'lib', 'site-packages'),
    root,
  ];
  return REQUIRED_PACKAGES.every((pkg) => sitePackages.some((base) => exists(fsImpl, path.join(base, pkg))));
}

export function detectDataScienceRuntime(
  { env = {}, fsImpl = fs }: { env?: EnvLike; fsImpl?: ExistsFs } = {},
): DataScienceRuntimeStatus {
  const configured = envValue(env, ['KCW_DATA_SCIENCE_HOME', 'KCW_DATA_SCIENCE_VENV']);
  if (!configured) {
    return { status: 'missing', detail: '未配置数据分析组件路径' };
  }
  if (!exists(fsImpl, configured.value)) {
    return { status: 'missing', source: configured.key, detail: '数据分析组件路径不存在' };
  }
  if (!hasPackageMarkers(configured.value, fsImpl)) {
    return { status: 'missing', source: configured.key, detail: '数据分析组件缺少 pandas/numpy/matplotlib' };
  }
  return { status: 'available', source: configured.key, detail: '数据分析组件可用' };
}
