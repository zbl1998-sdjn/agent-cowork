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
  networkIsolated: boolean;
  fallback: boolean;
  fallbackReason: string | null;
  userMessage: string;
  backends: StartupBackends;
};
export type SandboxStartupResult = {
  options: SandboxStartupOptions;
  info: SandboxStartupInfo;
};
