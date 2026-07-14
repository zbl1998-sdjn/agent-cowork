// OCR 运行时探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测 OCR 运行时(如 Tesseract/内置 OCR)是否就绪,供图片/扫描件取字能力开关。依赖:node:fs/path。
// 导出:detectOcrRuntime。
import fs from 'node:fs';
import path from 'node:path';

export type EnvLike = Record<string, string | undefined>;
export type ExistsFs = { existsSync(path: string): boolean };
export type OcrRuntimeStatus = {
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

function hasTessdata(root: string, fsImpl: ExistsFs): boolean {
  const dirs = [path.join(root, 'tessdata'), root];
  return dirs.some((dir) => exists(fsImpl, path.join(dir, 'chi_sim.traineddata'))
    || exists(fsImpl, path.join(dir, 'chi_tra.traineddata')));
}

export function detectOcrRuntime({ env = {}, fsImpl = fs }: { env?: EnvLike; fsImpl?: ExistsFs } = {}): OcrRuntimeStatus {
  const configured = envValue(env, ['ACW_TESSERACT_HOME', 'KCW_TESSERACT_HOME', 'ACW_TESSDATA_PREFIX', 'KCW_TESSDATA_PREFIX']);
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
