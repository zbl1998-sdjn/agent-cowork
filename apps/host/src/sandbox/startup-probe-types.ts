// 沙箱启动探测的类型契约(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:定义后端(docker/wsl/local)可用性探测的输入与结果结构,以及启动选项、
//       回退信息等,供 startup-probe 判定选用哪种沙箱后端及是否网络隔离。
export type ProbeError = { code?: string; message?: string };
export type ProbeResult = { status?: number | null; stdout?: unknown; stderr?: unknown; error?: ProbeError };
export type SpawnSyncLike = (command: string, args: readonly string[], options: Record<string, unknown>) => ProbeResult;
export type RuntimeEnv = Record<string, string | undefined>;
export type SandboxStartupOptions = {
  backend?: string;
  image?: string | null;
  distro?: string | null;
  [key: string]: unknown;
};
export type BackendProbe = {
  available: boolean;
  usable: boolean;
  networkIsolated: boolean;
  image?: string | null;
  imagePresent?: boolean;
  distro?: string | null;
  detail: string;
  reason: string;
};
export type StartupBackends = {
  docker: BackendProbe;
  wsl: BackendProbe;
  local: { available: boolean; usable: boolean; networkIsolated: boolean };
};
export type SandboxStartupInfo = {
  requestedBackend: string;
  selectedBackend: string;
  securityMode?: string;
  networkIsolated: boolean;
  fallback: boolean;
  policyBlocked?: boolean;
  fallbackReason: string | null;
  userMessage: string;
  backends: StartupBackends;
};
export type SandboxStartupResult = {
  options: SandboxStartupOptions;
  info: SandboxStartupInfo;
};
