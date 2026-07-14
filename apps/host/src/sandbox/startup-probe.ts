// 沙箱启动探测(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:启动时探测可用沙箱后端(docker 守护是否在、镜像是否就绪;wsl 是否可用),据此选定后端。
//       auto 模式优先选可用且能真断网的 docker,否则回退 local 并明确告知「本地不隔离网络」的事实。
//       显式指定后端则直接采用。诚实优先:绝不谎报网络隔离能力(plan/01 健壮性原则)。
// 依赖:node:child_process(spawnSync 可注入便于测试)。导出:resolveSandboxStartup。
import childProcess from 'node:child_process';
import { omitUndefined } from '../util/object.js';
import { isStrictLocalMode, resolveSecurityMode, type SecurityMode } from '../security/security-mode.js';
import { dockerImageFrom, probeDocker } from './startup-probe-docker.js';
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
    return docker.reason.includes('immutable') || docker.reason.includes('sha256')
      ? `Docker is available, but ${docker.reason}.`
      : `Docker is available, but image "${docker.image}" is not present locally.`;
  }
  if (docker.available && !docker.image) {
    return 'Docker is available, but ACW_SANDBOX_DOCKER_IMAGE is not configured.';
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
  securityMode,
}: {
  requestedBackend?: string;
  sandboxOptions: SandboxStartupOptions;
  docker: BackendProbe;
  wsl: BackendProbe;
  securityMode: SecurityMode;
}): SandboxStartupResult {
  const backend = String(requestedBackend || '').toLowerCase();
  const dockerUnavailable = backend === 'docker' && !docker.usable;
  const networkIsolated = backend === 'docker'
    ? docker.usable
    : backend === 'vm' || backend === 'hyperv';
  // 覆盖 local_demo/local_strict/air_gap 三种「严格本地」模式,不只 local_strict——
  // 此前只写 `=== 'local_strict'` 漏掉了更严格的 air_gap(机密档强制模式)。
  const policyBlocked = dockerUnavailable || (isStrictLocalMode(securityMode) && !networkIsolated);
  return {
    options: { ...sandboxOptions, backend },
    info: {
      requestedBackend: backend,
      selectedBackend: backend,
      securityMode,
      networkIsolated,
      fallback: false,
      policyBlocked,
      fallbackReason: null,
      userMessage: dockerUnavailable
        ? `Explicit Docker sandbox is unavailable; high-risk execution tools are blocked. ${docker.reason}`
        : policyBlocked
          ? `${securityMode}: explicit non-isolated sandbox backend requested; high-risk execution tools are blocked.`
        : (networkIsolated ? 'explicit VM sandbox backend requested' : LOCAL_WARNING),
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
  securityMode,
}: {
  requestedBackend?: string;
  sandboxOptions?: SandboxStartupOptions;
  env?: RuntimeEnv;
  spawnSync?: SpawnSyncLike;
  timeoutMs?: number;
  securityMode?: unknown;
} = {}): SandboxStartupResult {
  const mode = resolveSecurityMode({ configuredMode: securityMode, env });
  const image = dockerImageFrom({ sandboxOptions, env });
  const normalizedOptions = { ...sandboxOptions, ...(image ? { image } : {}) };
  const docker = probeDocker({ spawnSync, timeoutMs, image, runProbe });
  const wsl = probeWsl(omitUndefined({ spawnSync, timeoutMs, distro: normalizedOptions.distro }));
  const requested = String(requestedBackend || 'auto').toLowerCase();

  if (requested && requested !== 'auto') {
    return explicitStartup({
      requestedBackend: requested,
      sandboxOptions: normalizedOptions,
      docker,
      wsl,
      securityMode: mode,
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
        securityMode: mode,
        networkIsolated: true,
        fallback: false,
        policyBlocked: false,
        fallbackReason: null,
        userMessage: 'Docker sandbox selected; network is disabled by default.',
        backends,
      },
    };
  }

  const reason = fallbackReason(backends);
  // 覆盖 local_demo/local_strict/air_gap,不只 local_strict(同上,防漏检更严格的 air_gap)。
  const strictBlocked = isStrictLocalMode(mode);
  return {
    options: { ...normalizedOptions, backend: 'local' },
    info: {
      requestedBackend: 'auto',
      selectedBackend: 'local',
      securityMode: mode,
      networkIsolated: false,
      fallback: true,
      policyBlocked: strictBlocked,
      fallbackReason: reason,
      userMessage: strictBlocked
        ? `${mode}: no isolated sandbox is available; high-risk execution tools are blocked instead of falling back to local subprocess. ${reason}`
        : `${LOCAL_WARNING} ${reason}`,
      backends,
    },
  };
}
