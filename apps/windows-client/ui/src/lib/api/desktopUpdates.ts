// 桌面更新 API(UI · lib/api 传输层):经 Tauri invoke 触发外壳的检查更新/安装更新命令。
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
