// CJK 字体探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测系统是否安装中日韩字体(供 PDF/制品渲染避免中文豆腐块),返回可用字体信息。依赖:node:fs。
// 导出:detectCjkFonts。
import fs from 'node:fs';
import type { Dirent, Stats } from 'node:fs';

const FONT_RE = /\.(?:ttf|otf|ttc|woff2)$/i;

// 常见系统 CJK 字体候选。口径与 artifacts/pdf-cjk-font.ts 的 resolveCjkFontPath 保持一致
// (中文 Windows 默认装有黑体/雅黑/宋体等)——env 未显式指定字体包时回落探测这些系统字体,
// 让面板反映真实渲染能力:PDF/制品渲染本就用系统字体,不该在有系统中文字体的机器上误报「缺失」。
// (二者是不同分层的独立列表,这里刻意不跨域 import,新增字体时两处一起加。)
const SYSTEM_CJK_FONT_CANDIDATES: readonly string[] = Object.freeze([
  'C:/Windows/Fonts/msyh.ttc',      // 微软雅黑(简体 Windows 默认 UI 字体)
  'C:/Windows/Fonts/msyh.ttf',
  'C:/Windows/Fonts/simsun.ttc',    // 宋体
  'C:/Windows/Fonts/simhei.ttf',    // 黑体
  'C:/Windows/Fonts/Deng.ttf',      // 等线
  'C:/Windows/Fonts/simkai.ttf',    // 楷体
  'C:/Windows/Fonts/msgothic.ttc',  // 日文 MS Gothic
  'C:/Windows/Fonts/meiryo.ttc',    // 日文 Meiryo
  'C:/Windows/Fonts/malgun.ttf',    // 韩文 Malgun Gothic
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/PingFang.ttc',
]);

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

/** 无显式配置时,回落探测系统 CJK 字体;命中返回可用(source='system'),否则 null。 */
function detectSystemCjkFont(fsImpl: FontFs): FontRuntimeStatus | null {
  const hit = SYSTEM_CJK_FONT_CANDIDATES.find((candidate) => hasFontFile(candidate, fsImpl));
  if (!hit) return null;
  const name = hit.split(/[\\/]/).pop() || hit;
  return { status: 'available', source: 'system', detail: `系统 CJK 字体可用(${name})` };
}

export function detectCjkFonts({ env = {}, fsImpl = fs }: { env?: EnvLike; fsImpl?: FontFs } = {}): FontRuntimeStatus {
  const configured = envValue(env, ['ACW_CJK_FONT_DIR', 'KCW_CJK_FONT_DIR', 'ACW_CJK_FONT', 'KCW_CJK_FONT']);
  if (!configured) {
    // env 未显式指定字体包:回落探测系统字体(与 PDF 渲染实际使用的字体一致)。
    return detectSystemCjkFont(fsImpl)
      || { status: 'missing', detail: '未配置 CJK 字体包路径,系统也未探测到中日韩字体' };
  }
  if (!hasFontFile(configured.value, fsImpl)) {
    return { status: 'missing', source: configured.key, detail: 'CJK 字体路径不存在或未包含字体文件' };
  }
  return { status: 'available', source: configured.key, detail: 'CJK 字体包可用' };
}
