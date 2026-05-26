// @ts-check
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_PACKAGES = ['pandas', 'numpy', 'matplotlib'];

/**
 * @typedef {Record<string, string | undefined>} EnvLike
 * @typedef {{ existsSync(path: string): boolean }} ExistsFs
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
 * @param {ExistsFs} fsImpl
 * @param {string} target
 * @returns {boolean}
 */
function exists(fsImpl, target) {
  try {
    return fsImpl.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @param {ExistsFs} fsImpl
 * @returns {boolean}
 */
function hasPackageMarkers(root, fsImpl) {
  const sitePackages = [
    path.join(root, 'Lib', 'site-packages'),
    path.join(root, 'lib', 'site-packages'),
    root,
  ];
  return REQUIRED_PACKAGES.every((pkg) => sitePackages.some((base) => exists(fsImpl, path.join(base, pkg))));
}

/**
 * @param {{ env?: EnvLike, fsImpl?: ExistsFs }} [options]
 */
export function detectDataScienceRuntime({ env = {}, fsImpl = fs } = {}) {
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
