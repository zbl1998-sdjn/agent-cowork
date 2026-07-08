// Microsoft Edge WebView2 运行时探测(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:探测 Windows 桌面外壳依赖的 WebView2 Evergreen 运行时是否已安装。优先认
//       KCW_WEBVIEW2_MODE / WEBVIEW2_RELEASE_CHANNEL_PREFERENCE env;否则实地探测标准安装
//       目录(%ProgramFiles(x86)%/%ProgramFiles%/%LOCALAPPDATA% 下 Microsoft\EdgeWebView\
//       Application,或随 Edge 浏览器附带的 Microsoft\Edge\Application)。探测不到时保持
//       unknown(而非误判缺失),由安装器/Windows 运行时兜底。dogfood 2026-07-09:此前 win32
//       一律 unknown「待检测」,在已装 WebView2(桌面外壳正靠它渲染)的机器上也不显示可用。
// 依赖:node:fs/path。导出:detectWebview2。
import fs from 'node:fs';
import path from 'node:path';

export type EnvLike = Record<string, string | undefined>;
export type Webview2Fs = { existsSync(path: string): boolean };
export type Webview2Status = {
  status: 'configured' | 'available' | 'unknown' | 'not_applicable';
  source?: string;
  detail: string;
};

const WEBVIEW2_APP_SUBPATH = ['Microsoft', 'EdgeWebView', 'Application'];
const EDGE_APP_SUBPATH = ['Microsoft', 'Edge', 'Application'];

function envValue(env: EnvLike, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, value: value.trim() };
    }
  }
  return null;
}

/** WebView2 运行时(或随 Edge 附带的运行时)标准安装目录候选。 */
function candidateDirs(env: EnvLike): string[] {
  const bases = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]
    .filter((base): base is string => typeof base === 'string' && base.trim().length > 0);
  const dirs: string[] = [];
  for (const base of bases) {
    dirs.push(path.join(base, ...WEBVIEW2_APP_SUBPATH));
    dirs.push(path.join(base, ...EDGE_APP_SUBPATH));
  }
  return dirs;
}

function exists(fsImpl: Webview2Fs, target: string): boolean {
  try {
    return fsImpl.existsSync(target);
  } catch {
    return false;
  }
}

export function detectWebview2(
  { env = {}, platform = process.platform, fsImpl = fs }: { env?: EnvLike; platform?: string; fsImpl?: Webview2Fs } = {},
): Webview2Status {
  const configured = envValue(env, ['KCW_WEBVIEW2_MODE', 'WEBVIEW2_RELEASE_CHANNEL_PREFERENCE']);
  if (configured) {
    return { status: 'configured', source: configured.key, detail: `WebView2 模式: ${configured.value}` };
  }
  if (platform !== 'win32') {
    return { status: 'not_applicable', detail: '仅 Windows 需要' };
  }
  for (const dir of candidateDirs(env)) {
    if (exists(fsImpl, dir)) {
      return { status: 'available', detail: 'WebView2 运行时已安装(系统)' };
    }
  }
  return { status: 'unknown', detail: '需要安装器或 Windows 运行时探测确认' };
}
