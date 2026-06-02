// CJK 字体探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测系统是否安装中日韩字体(供 PDF/制品渲染避免中文豆腐块),返回可用字体信息。依赖:node:fs。
// 导出:detectCjkFonts。
import fs from 'node:fs';
import type { Dirent, Stats } from 'node:fs';

const FONT_RE = /\.(?:ttf|otf|ttc|woff2)$/i;

export type EnvLike = Record<string, string | undefined>;
export type FontFs = {
  statSync(path: string): Stats;
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
};
export type FontRuntimeStatus = {
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

function hasFontFile(target: string, fsImpl: FontFs): boolean {
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

export function detectCjkFonts({ env = {}, fsImpl = fs }: { env?: EnvLike; fsImpl?: FontFs } = {}): FontRuntimeStatus {
  const configured = envValue(env, ['KCW_CJK_FONT_DIR', 'KCW_CJK_FONT']);
  if (!configured) {
    return { status: 'missing', detail: '未配置 CJK 字体包路径' };
  }
  if (!hasFontFile(configured.value, fsImpl)) {
    return { status: 'missing', source: configured.key, detail: 'CJK 字体路径不存在或未包含字体文件' };
  }
  return { status: 'available', source: configured.key, detail: 'CJK 字体包可用' };
}
