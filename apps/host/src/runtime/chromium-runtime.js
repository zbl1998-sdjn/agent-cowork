import fs from 'node:fs';
import path from 'node:path';

function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

function isChromiumBinary(filePath) {
  return /^(chrome|chromium)(?:\.exe)?$/i.test(path.basename(filePath || ''));
}

function isFile(fsImpl, target) {
  try {
    return fsImpl.statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasChromiumBinary(home, fsImpl) {
  return [
    path.join(home, 'chrome.exe'),
    path.join(home, 'chromium.exe'),
    path.join(home, 'chrome'),
    path.join(home, 'chromium'),
    path.join(home, 'chrome-win', 'chrome.exe'),
    path.join(home, 'chromium', 'chrome.exe'),
  ].some((candidate) => isFile(fsImpl, candidate));
}

export function detectChromiumRuntime({ env = {}, fsImpl = fs } = {}) {
  const configured = envValue(env, ['KCW_CHROMIUM_EXECUTABLE', 'KCW_PLAYWRIGHT_CHROMIUM_HOME']);
  if (!configured) {
    return { status: 'missing', detail: '未配置浏览器自动化组件路径' };
  }
  if (configured.key === 'KCW_CHROMIUM_EXECUTABLE') {
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
