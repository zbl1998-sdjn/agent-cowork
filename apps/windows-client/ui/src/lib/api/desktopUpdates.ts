// 桌面更新 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:经 Tauri invoke 触发外壳的检查更新/安装更新命令(非 HTTP,走桌面壳)。
// 依赖/对应路由:invokeDesktop('check_desktop_update' | 'install_desktop_update')。导出:checkDesktopUpdate / installDesktopUpdate + 状态类型。
import { invokeDesktop } from './transport';

export interface DesktopUpdateStatus {
  available: boolean;
  currentVersion: string;
  version?: string | null;
  date?: string | null;
  body?: string | null;
}

export interface DesktopUpdateInstallResult {
  installed: boolean;
  currentVersion: string;
  version?: string | null;
}

export function checkDesktopUpdate(): Promise<DesktopUpdateStatus> {
  return invokeDesktop<DesktopUpdateStatus>('check_desktop_update');
}

export function installDesktopUpdate(): Promise<DesktopUpdateInstallResult> {
  return invokeDesktop<DesktopUpdateInstallResult>('install_desktop_update');
}
