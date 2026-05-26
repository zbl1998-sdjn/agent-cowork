// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Record<string, string | undefined>} EnvLike
 * @typedef {{ statSync(path: string): import('node:fs').Stats }} StatFs
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
 * @param {string} filePath
 * @returns {boolean}
 */
function isPandocBinary(filePath) {
  return /^pandoc(?:\.exe)?$/i.test(path.basename(filePath || ''));
}

/**
 * @param {StatFs} fsImpl
 * @param {string} target
 * @returns {boolean}
 */
function isFile(fsImpl, target) {
  try {
    return fsImpl.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} home
 * @param {StatFs} fsImpl
 * @returns {boolean}
 */
function hasPandocBinary(home, fsImpl) {
  return [
    path.join(home, 'pandoc.exe'),
    path.join(home, 'pandoc'),
    path.join(home, 'bin', 'pandoc.exe'),
    path.join(home, 'bin', 'pandoc'),
  ].some((candidate) => isFile(fsImpl, candidate));
}

/**
 * @param {{ env?: EnvLike, fsImpl?: StatFs }} [options]
 */
export function detectPandocRuntime({ env = {}, fsImpl = fs } = {}) {
  const configured = envValue(env, ['KCW_PANDOC_EXE', 'KCW_PANDOC_HOME']);
  if (!configured) {
    return { status: 'missing', detail: '未配置 Pandoc 组件路径' };
  }
  if (configured.key === 'KCW_PANDOC_EXE') {
    if (!isFile(fsImpl, configured.value) || !isPandocBinary(configured.value)) {
      return { status: 'missing', source: configured.key, detail: 'Pandoc 可执行文件不存在或名称不匹配' };
    }
    return { status: 'available', source: configured.key, detail: 'Pandoc 组件可用' };
  }
  if (!hasPandocBinary(configured.value, fsImpl)) {
    return { status: 'missing', source: configured.key, detail: 'Pandoc 组件目录缺少 pandoc 可执行文件' };
  }
  return { status: 'available', source: configured.key, detail: 'Pandoc 组件可用' };
}
