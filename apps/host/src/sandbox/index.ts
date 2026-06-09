// 沙箱工厂(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:按 backend 选择沙箱适配器(本地子进程 / VM:docker/wsl/hyperv)。各适配器实现
//       同一 exec(spec, ctx) 契约,故调用方与路由后端无关——这是「端口与适配器」接缝,
//       也是多沙箱后端可扩展的关键(新增后端=加一个适配器,不改调用方)。
// 依赖:同目录 local-sandbox / vm-sandbox / wsl-docker-runner / sandbox-spec。
// 导出:createSandbox + DEFAULT_ALLOW_TOOLS,并转出 normalizeSandboxSpec/SANDBOX_DEFAULTS/createWslDockerRunner。
import { LocalSubprocessSandbox } from './local-sandbox.js';
import { VmSandbox } from './vm-sandbox.js';
import { createWslDockerRunner } from './wsl-docker-runner.js';
import { normalizeSandboxSpec, SANDBOX_DEFAULTS } from './sandbox-spec.js';
import { omitUndefined } from '../util/object.js';
import type { SpawnLike } from './exec-child.js';
import type { VmRunner } from './vm-sandbox.js';

export { normalizeSandboxSpec, SANDBOX_DEFAULTS };
export { createWslDockerRunner };

// 保守默认工具 allowlist:足够运行 Python/Node 数据清理,但不暴露任意宿主二进制;需要时经配置扩展。
export const DEFAULT_ALLOW_TOOLS = Object.freeze([
  'node',
  'python',
  'python3',
]);

const VM_BACKENDS = new Set(['vm', 'docker', 'wsl', 'hyperv']);

export type SandboxOptions = {
  backend?: string;
  vmBackend?: string;
  runner?: VmRunner | null;
  provisioned?: boolean;
  image?: string | null;
  distro?: string | null;
  spawn?: SpawnLike;
};

/** 按 backend 创建沙箱:local->子进程;vm/docker/wsl/hyperv->VM(能真正运行才算 provisioned,否则快速失败)。 */
export function createSandbox(options: SandboxOptions = {}): LocalSubprocessSandbox | VmSandbox {
  const backend = String(options.backend || 'local').toLowerCase();

  if (backend === 'local' || backend === 'local-subprocess') {
    return new LocalSubprocessSandbox(options);
  }

  if (VM_BACKENDS.has(backend)) {
    const vmBackend = backend === 'vm' ? (options.vmBackend || 'docker') : backend;
    // VM 后端只有在能真正运行时才算 provisioned:显式 runner,或足够构造 runner 的配置(docker image / wsl)。
    // 否则 VmSandbox 快速 501 失败,不假装已隔离。
    let runner = options.runner || null;
    if (!runner) {
      const canProvision =
        options.provisioned === true ||
        (vmBackend === 'docker' && Boolean(options.image)) ||
        (vmBackend === 'wsl');
      if (canProvision) {
        runner = createWslDockerRunner(omitUndefined({
          backend: vmBackend,
          image: options.image,
          distro: options.distro,
          spawn: options.spawn,
        }));
      }
    }
    return new VmSandbox(omitUndefined({
      backend: vmBackend,
      image: options.image,
      distro: options.distro,
      runner,
      provisioned: Boolean(runner),
    }));
  }

  throw new Error(`createSandbox: unknown backend "${backend}"`);
}
