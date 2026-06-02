// Pandoc 运行时探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测 pandoc 是否就绪(文档格式互转能力),供制品导出/格式转换能力开关。依赖:node:fs/path。
// 导出:detectPandocRuntime。
import fs from 'node:fs';
import path from 'node:path';
import type { Stats } from 'node:fs';

export type EnvLike = Record<string, string | undefined>;
export type StatFs = { statSync(path: string): Stats };
export type PandocRuntimeStatus = {
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

function isPandocBinary(filePath: string): boolean {
  return /^pandoc(?:\.exe)?$/i.test(path.basename(filePath || ''));
}

function isFile(fsImpl: StatFs, target: string): boolean {
  try {
    return fsImpl.statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasPandocBinary(home: string, fsImpl: StatFs): boolean {
  return [
    path.join(home, 'pandoc.exe'),
    path.join(home, 'pandoc'),
    path.join(home, 'bin', 'pandoc.exe'),
    path.join(home, 'bin', 'pandoc'),
  ].some((candidate) => isFile(fsImpl, candidate));
}

export function detectPandocRuntime({ env = {}, fsImpl = fs }: { env?: EnvLike; fsImpl?: StatFs } = {}): PandocRuntimeStatus {
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
