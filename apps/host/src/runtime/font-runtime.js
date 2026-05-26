// @ts-check
import fs from 'node:fs';

const FONT_RE = /\.(?:ttf|otf|ttc|woff2)$/i;

/**
 * @typedef {Record<string, string | undefined>} EnvLike
 * @typedef {{ statSync(path: string): import('node:fs').Stats, readdirSync(path: string, options: { withFileTypes: true }): import('node:fs').Dirent[] }} FontFs
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
 * @param {string} target
 * @param {FontFs} fsImpl
 * @returns {boolean}
 */
function hasFontFile(target, fsImpl) {
  let stat;
  try {
    stat = fsImpl.statSync(target);
  } catch {
    return false;
  }
  if (stat.isFile()) return FONT_RE.test(target);
  if (!stat.isDirectory()) return false;
  try {
    return fsImpl.readdirSync(target, { withFileTypes: true })
      .some((entry) => entry.isFile() && FONT_RE.test(entry.name));
  } catch {
    return false;
  }
}

/**
 * @param {{ env?: EnvLike, fsImpl?: FontFs }} [options]
 */
export function detectCjkFonts({ env = {}, fsImpl = fs } = {}) {
  const configured = envValue(env, ['KCW_CJK_FONT_DIR', 'KCW_CJK_FONT']);
  if (!configured) {
    return { status: 'missing', detail: '未配置 CJK 字体包路径' };
  }
  if (!hasFontFile(configured.value, fsImpl)) {
    return { status: 'missing', source: configured.key, detail: 'CJK 字体路径不存在或未包含字体文件' };
  }
  return { status: 'available', source: configured.key, detail: 'CJK 字体包可用' };
}
