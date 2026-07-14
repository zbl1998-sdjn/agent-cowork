// Docker 启动探测(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:解析配置中的 Docker 镜像身份,并在短超时探测中验证 daemon、不可变镜像
//       策略和本地镜像存在性。选择/回退决策仍由 startup-probe 统一负责。
import { isImmutableDockerImage } from './wsl-docker-runner.js';
import { readCompatEnv } from '../util/env-compat.js';
import type {
  BackendProbe,
  RuntimeEnv,
  SandboxStartupOptions,
  SpawnSyncLike,
} from './startup-probe-types.js';

type ProbeRunner = (
  spawnSync: SpawnSyncLike,
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => { ok: boolean; detail: string };

export function dockerImageFrom({
  sandboxOptions = {},
  env = {},
}: { sandboxOptions?: SandboxStartupOptions; env?: RuntimeEnv }): string | null {
  return sandboxOptions.image
    || readCompatEnv(env, 'ACW_SANDBOX_DOCKER_IMAGE', 'KCW_SANDBOX_DOCKER_IMAGE')
    || readCompatEnv(env, 'ACW_SANDBOX_IMAGE', 'KCW_SANDBOX_IMAGE')
    || null;
}

export function probeDocker({
  spawnSync,
  timeoutMs,
  image,
  runProbe,
}: {
  spawnSync: SpawnSyncLike;
  timeoutMs: number;
  image?: string | null;
  runProbe: ProbeRunner;
}): BackendProbe {
  const docker: BackendProbe = {
    available: false,
    usable: false,
    networkIsolated: true,
    image: image || null,
    imagePresent: false,
    detail: '',
    reason: '',
  };
  const info = runProbe(spawnSync, 'docker', ['info', '--format', '{{.ServerVersion}}'], timeoutMs);
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
  if (!isImmutableDockerImage(image)) {
    docker.reason = 'docker image must use an immutable sha256 digest or local sha256 image ID';
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
