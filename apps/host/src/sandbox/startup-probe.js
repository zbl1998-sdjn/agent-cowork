import childProcess from 'node:child_process';

/**
 * @typedef {{ code?: string, message?: string }} ProbeError
 * @typedef {{ status?: number | null, stdout?: unknown, stderr?: unknown, error?: ProbeError }} ProbeResult
 * @typedef {(command: string, args: readonly string[], options: Record<string, unknown>) => ProbeResult} SpawnSyncLike
 * @typedef {Record<string, string | undefined>} RuntimeEnv
 * @typedef {{ backend?: string, image?: string | null, distro?: string | null, [key: string]: unknown }} SandboxStartupOptions
 * @typedef {{ available: boolean, usable: boolean, networkIsolated: boolean, image?: string | null, imagePresent?: boolean, distro?: string | null, detail: string, reason: string }} BackendProbe
 * @typedef {{ docker: BackendProbe, wsl: BackendProbe, local: { available: boolean, usable: boolean, networkIsolated: boolean } }} StartupBackends
 */

const DOCKER_INFO_ARGS = Object.freeze(['info', '--format', '{{.ServerVersion}}']);
const WSL_STATUS_ARGS = Object.freeze(['--status']);
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const LOCAL_WARNING = '本地不隔离网络: local sandbox runs on the host and cannot enforce network isolation.';

/** @param {unknown} value @returns {string} */
function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * @param {SpawnSyncLike} spawnSync
 * @param {string} command
 * @param {readonly string[]} args
 * @param {number} timeoutMs
 * @returns {{ ok: boolean, detail: string }}
 */
function runProbe(spawnSync, command, args, timeoutMs) {
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

/** @param {{ sandboxOptions?: SandboxStartupOptions, env?: RuntimeEnv }} options @returns {string | null} */
function dockerImageFrom({ sandboxOptions = {}, env = {} }) {
  return sandboxOptions.image
    || env.KCW_SANDBOX_DOCKER_IMAGE
    || env.KCW_SANDBOX_IMAGE
    || null;
}

/** @param {{ spawnSync: SpawnSyncLike, timeoutMs: number, image?: string | null }} options @returns {BackendProbe} */
function probeDocker({ spawnSync, timeoutMs, image }) {
  const docker = {
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

/** @param {{ spawnSync: SpawnSyncLike, timeoutMs: number, distro?: string | null }} options @returns {BackendProbe} */
function probeWsl({ spawnSync, timeoutMs, distro }) {
  const wsl = {
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

/** @param {StartupBackends} backends @returns {string} */
function fallbackReason(backends) {
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
 * @param {{ requestedBackend?: string, sandboxOptions: SandboxStartupOptions, docker: BackendProbe, wsl: BackendProbe }} options
 * @returns {{ options: SandboxStartupOptions, info: Record<string, unknown> }}
 */
function explicitStartup({ requestedBackend, sandboxOptions, docker, wsl }) {
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
 * @param {{ requestedBackend?: string, sandboxOptions?: SandboxStartupOptions, env?: RuntimeEnv, spawnSync?: SpawnSyncLike, timeoutMs?: number }} [options]
 * @returns {{ options: SandboxStartupOptions, info: Record<string, unknown> }}
 */
export function resolveSandboxStartup({
  requestedBackend = 'auto',
  sandboxOptions = {},
  env = process.env,
  spawnSync = childProcess.spawnSync,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const image = dockerImageFrom({ sandboxOptions, env });
  const normalizedOptions = { ...sandboxOptions, ...(image ? { image } : {}) };
  const docker = probeDocker({ spawnSync, timeoutMs, image });
  const wsl = probeWsl({ spawnSync, timeoutMs, distro: normalizedOptions.distro });
  const requested = String(requestedBackend || 'auto').toLowerCase();

  if (requested && requested !== 'auto') {
    return explicitStartup({
      requestedBackend: requested,
      sandboxOptions: normalizedOptions,
      docker,
      wsl,
    });
  }

  const backends = {
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
