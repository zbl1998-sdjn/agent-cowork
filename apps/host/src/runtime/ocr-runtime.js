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

function exists(fsImpl, target) {
  try {
    return fsImpl.existsSync(target);
  } catch {
    return false;
  }
}

function hasTessdata(root, fsImpl) {
  const dirs = [path.join(root, 'tessdata'), root];
  return dirs.some((dir) => exists(fsImpl, path.join(dir, 'chi_sim.traineddata'))
    || exists(fsImpl, path.join(dir, 'chi_tra.traineddata')));
}

export function detectOcrRuntime({ env = {}, fsImpl = fs } = {}) {
  const configured = envValue(env, ['KCW_TESSERACT_HOME', 'KCW_TESSDATA_PREFIX']);
  if (!configured) {
    return { status: 'missing', detail: '未配置 OCR 组件路径' };
  }
  if (!exists(fsImpl, configured.value)) {
    return { status: 'missing', source: configured.key, detail: 'OCR 组件路径不存在' };
  }
  if (!hasTessdata(configured.value, fsImpl)) {
    return { status: 'missing', source: configured.key, detail: 'OCR 组件缺少中文语言包' };
  }
  return { status: 'available', source: configured.key, detail: 'OCR 中文语言包可用' };
}
