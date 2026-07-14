// Chromium 运行时探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测可用的 Chromium/浏览器内核(用于网页抓取、HTML→PDF 等),供相关能力开关。依赖:node:fs/path。
// 导出:detectChromiumRuntime。
import fs from 'node:fs';
import path from 'node:path';
import type { Stats } from 'node:fs';

export type EnvLike = Record<string, string | undefined>;
export type StatFs = { statSync(path: string): Stats };
export type ChromiumRuntimeStatus = {
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

function isChromiumBinary(filePath: string): boolean {
  return /^(chrome|chromium)(?:\.exe)?$/i.test(path.basename(filePath || ''));
}

function isFile(fsImpl: StatFs, target: string): boolean {
  try {
    return fsImpl.statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasChromiumBinary(home: string, fsImpl: StatFs): boolean {
  return [
    path.join(home, 'chrome.exe'),
    path.join(home, 'chromium.exe'),
    path.join(home, 'chrome'),
    path.join(home, 'chromium'),
    path.join(home, 'chrome-win', 'chrome.exe'),
    path.join(home, 'chromium', 'chrome.exe'),
  ].some((candidate) => isFile(fsImpl, candidate));
}

export function detectChromiumRuntime({ env = {}, fsImpl = fs }: { env?: EnvLike; fsImpl?: StatFs } = {}): ChromiumRuntimeStatus {
  const configured = envValue(env, ['ACW_CHROMIUM_EXECUTABLE', 'KCW_CHROMIUM_EXECUTABLE', 'ACW_PLAYWRIGHT_CHROMIUM_HOME', 'KCW_PLAYWRIGHT_CHROMIUM_HOME']);
  if (!configured) {
    return { status: 'missing', detail: '未配置浏览器自动化组件路径' };
  }
  if (configured.key === 'ACW_CHROMIUM_EXECUTABLE' || configured.key === 'KCW_CHROMIUM_EXECUTABLE') {
    if (!isFile(fsImpl, configured.value) || !isChromiumBinary(configured.value)) {
      return { status: 'missing', source: configured.key, detail: 'Chromium 可执行文件不存在或名称不匹配' };
    }
    return { status: 'available', source: configured.key, detail: '浏览器自动化组件可用' };
  }
  if (!hasChromiumBinary(configured.value, fsImpl)) {
    return { status: 'missing', source: configured.key, detail: '浏览器自动化组件目录缺少 Chromium 可执行文件' };
  }
  return { status: 'available', source: configured.key, detail: '浏览器自动化组件可用' };
}
