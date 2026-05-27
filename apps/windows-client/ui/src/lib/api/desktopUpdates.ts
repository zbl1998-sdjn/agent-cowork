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
