// 沙箱启动探测(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:启动时探测可用沙箱后端(docker 守护是否在、镜像是否就绪;wsl 是否可用),据此选定后端。
//       auto 模式优先选可用且能真断网的 docker,否则回退 local 并明确告知「本地不隔离网络」的事实。
//       显式指定后端则直接采用。诚实优先:绝不谎报网络隔离能力(plan/01 健壮性原则)。
// 依赖:node:child_process(spawnSync 可注入便于测试)。导出:resolveSandboxStartup。
import childProcess from 'node:child_process';
import { omitUndefined } from '../util/object.js';
import type {
  BackendProbe,
  RuntimeEnv,
  SandboxStartupOptions,
  SandboxStartupResult,
  SpawnSyncLike,
  StartupBackends,
} from './startup-probe-types.js';

export type {
  BackendProbe,
  ProbeError,
  ProbeResult,
  RuntimeEnv,
  SandboxStartupOptions,
  SandboxStartupResult,
  SpawnSyncLike,
  StartupBackends,
} from './startup-probe-types.js';

const DOCKER_INFO_ARGS = Object.freeze(['info', '--format', '{{.ServerVersion}}']);
const WSL_STATUS_ARGS = Object.freeze(['--status']);
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const LOCAL_WARNING = '本地不隔离网络: local sandbox runs on the host and cannot enforce network isolation.';

function cleanText(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * 执行一次短超时后端探测,把异常、非零退出和标准输出统一折叠为可展示 detail。
 */
function runProbe(
  spawnSync: SpawnSyncLike,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): { ok: boolean; detail: string } {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) {
      return { ok: false, detail: cleanText(result.error.code || result.error.message) };
    }
    if (result.status !== 0) {
      return { ok: false, detail: cleanText(result.stderr || result.stdout || `exit ${result.status}`) };
    }
    return { ok: true, detail: cleanText(result.stdout || result.stderr) };
  } catch (err) {
    const message = err instanceof Error ? err.message : err;
    return { ok: false, detail: cleanText(message) };
  }
}

function dockerImageFrom({
  sandboxOptions = {},
  env = {},
}: { sandboxOptions?: SandboxStartupOptions; env?: RuntimeEnv }): string | null {
  return sandboxOptions.image
    || env.KCW_SANDBOX_DOCKER_IMAGE
    || env.KCW_SANDBOX_IMAGE
    || null;
}

function probeDocker({
  spawnSync,
  timeoutMs,
  image,
}: { spawnSync: SpawnSyncLike; timeoutMs: number; image?: string | null }): BackendProbe {
  const docker: BackendProbe = {
    available: false,
    usable: false,
    networkIsolated: true,
    image: image || null,
    imagePresent: false,
    detail: '',
    reason: '',
  };
  const info = runProbe(spawnSync, 'docker', DOCKER_INFO_ARGS, timeoutMs);
  docker.available = info.ok;
  docker.detail = info.detail;
  if (!info.ok) {
    docker.reason = info.detail || 'docker daemon unavailable';
    return docker;
  }
  if (!image) {
    docker.reason = 'docker image is not configured';
    return docker;
  }
  const imageCheck = runProbe(spawnSync, 'docker', ['image', 'inspect', image], timeoutMs);
  docker.imagePresent = imageCheck.ok;
  docker.usable = imageCheck.ok;
  if (!imageCheck.ok) {
    docker.reason = `docker image is not present locally: ${imageCheck.detail || image}`;
  }
  return docker;
}

function probeWsl({
  spawnSync,
  timeoutMs,
  distro,
}: { spawnSync: SpawnSyncLike; timeoutMs: number; distro?: string | null }): BackendProbe {
  const wsl: BackendProbe = {
    available: false,
    usable: false,
    networkIsolated: false,
    distro: distro || null,
    detail: '',
    reason: 'wsl backend does not guarantee network isolation by default',
  };
  const status = runProbe(spawnSync, 'wsl.exe', WSL_STATUS_ARGS, timeoutMs);
  wsl.available = status.ok;
  wsl.usable = status.ok;
  wsl.detail = status.detail;
  if (!status.ok) wsl.reason = status.detail || 'wsl unavailable';
  return wsl;
}

function fallbackReason(backends: StartupBackends): string {
  const docker = backends.docker;
  if (docker.available && docker.image && !docker.imagePresent) {
    return `Docker is available, but image "${docker.image}" is not present locally.`;
  }
  if (docker.available && !docker.image) {
    return 'Docker is available, but KCW_SANDBOX_DOCKER_IMAGE is not configured.';
  }
  if (backends.wsl.available) {
    return 'WSL is available, but this host cannot guarantee WSL network isolation.';
  }
  return 'No Docker backend with a local image is available.';
}

/**
 * 显式指定后端时直接尊重用户选择,只把隔离能力和探测结果诚实写进 info。
 */
function explicitStartup({
  requestedBackend,
  sandboxOptions,
  docker,
  wsl,
}: {
  requestedBackend?: string;
  sandboxOptions: SandboxStartupOptions;
  docker: BackendProbe;
  wsl: BackendProbe;
}): SandboxStartupResult {
  const backend = String(requestedBackend || '').toLowerCase();
  const networkIsolated = backend === 'docker' || backend === 'vm' || backend === 'hyperv';
  return {
    options: { ...sandboxOptions, backend },
    info: {
      requestedBackend: backend,
      selectedBackend: backend,
      networkIsolated,
      fallback: false,
      fallbackReason: null,
      userMessage: networkIsolated ? 'explicit VM sandbox backend requested' : LOCAL_WARNING,
      backends: {
        docker,
        wsl,
        local: { available: true, usable: true, networkIsolated: false },
      },
    },
  };
}

/**
 * 探测并选定沙箱后端:返回 { options(含 backend), info(选中后端/是否隔离/回退原因/给用户的话) }。
 */
export function resolveSandboxStartup({
  requestedBackend = 'auto',
  sandboxOptions = {},
  env = process.env,
  spawnSync = childProcess.spawnSync,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}: {
  requestedBackend?: string;
  sandboxOptions?: SandboxStartupOptions;
  env?: RuntimeEnv;
  spawnSync?: SpawnSyncLike;
  timeoutMs?: number;
} = {}): SandboxStartupResult {
  const image = dockerImageFrom({ sandboxOptions, env });
  const normalizedOptions = { ...sandboxOptions, ...(image ? { image } : {}) };
  const docker = probeDocker({ spawnSync, timeoutMs, image });
  const wsl = probeWsl(omitUndefined({ spawnSync, timeoutMs, distro: normalizedOptions.distro }));
  const requested = String(requestedBackend || 'auto').toLowerCase();

  if (requested && requested !== 'auto') {
    return explicitStartup({
      requestedBackend: requested,
      sandboxOptions: normalizedOptions,
      docker,
      wsl,
    });
  }

  const backends: StartupBackends = {
    docker,
    wsl,
    local: { available: true, usable: true, networkIsolated: false },
  };
  if (docker.usable) {
    return {
      options: { ...normalizedOptions, backend: 'docker' },
      info: {
        requestedBackend: 'auto',
        selectedBackend: 'docker',
        networkIsolated: true,
        fallback: false,
        fallbackReason: null,
        userMessage: 'Docker sandbox selected; network is disabled by default.',
        backends,
      },
    };
  }

  const reason = fallbackReason(backends);
  return {
    options: { ...normalizedOptions, backend: 'local' },
    info: {
      requestedBackend: 'auto',
      selectedBackend: 'local',
      networkIsolated: false,
      fallback: true,
      fallbackReason: reason,
      userMessage: `${LOCAL_WARNING} ${reason}`,
      backends,
    },
  };
}
