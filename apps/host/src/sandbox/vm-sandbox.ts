// VM 沙箱适配器(契约,host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:提供「真隔离」目标——在轻量 Linux VM/容器内运行工具,挂载可信根、默认断网。
//       与 LocalSubprocessSandbox 共享 exec(spec,ctx) 契约,换后端不动路由与调用点。
//       支持 wsl / docker / hyperv(在部署期 provision,不在此处);未就绪时 exec 快速失败(501)
//       而非静默退回无隔离进程——隔离保证正是本适配器的全部意义。
// 依赖:同层 sandbox-spec(类型)+wsl-docker-runner(Docker 安全基线)。导出:VmSandbox。
import type { SandboxSpec } from './sandbox-spec.js';
import { dockerSandboxFlags } from './wsl-docker-runner.js';

type HttpError = Error & { statusCode?: number };
export type SandboxExecContext = { trustedRoot?: string; context?: Record<string, unknown> };
export type VmPlan = { argv: string[]; networkIsolated: boolean } | null;
export type VmRunner = (plan: VmPlan, spec: SandboxSpec, ctx: SandboxExecContext) => unknown | Promise<unknown>;

/** 据后端拼出执行计划(argv + 是否网络隔离):docker --network=none、wsl、hyperv;未知返回 null。 */
function buildPlan(backend: string, spec: SandboxSpec, mountRoot: string): VmPlan {
  switch (backend) {
    case 'docker':
      return {
        argv: [
          'docker', 'run', '--rm',
          ...dockerSandboxFlags(spec, mountRoot),
          // image + tool + args appended by the real implementation
        ],
        networkIsolated: !spec.network,
      };
    case 'wsl':
      return {
        argv: ['wsl.exe', '--', spec.tool, ...spec.args],
        networkIsolated: false, // requires per-distro netns config to guarantee
      };
    case 'hyperv':
      return { argv: [], networkIsolated: !spec.network };
    default:
      return null;
  }
}

/** VM 沙箱:把执行计划交给注入的 runner 真正运行;runner 缺失即视为未 provision。 */
export class VmSandbox {
  backend: string;
  vmBackend: string;
  image: string | null;
  distro: string | null;
  networkIsolated: boolean;
  private _runner: VmRunner | null;
  private _provisioned: boolean;

  constructor({
    backend = 'docker',
    image = null,
    distro = null,
    provisioned = false,
    runner = null,
  }: {
    backend?: string;
    image?: string | null;
    distro?: string | null;
    provisioned?: boolean;
    runner?: VmRunner | null;
  } = {}) {
    this.backend = `vm:${backend}`;
    this.vmBackend = backend;
    this.image = image;
    this.distro = distro;
    this.networkIsolated = backend !== 'wsl';
    // runner 由部署层注入真实 spawn 执行器;缺失时视为 VM 后端未 provision。
    this._runner = runner;
    this._provisioned = provisioned && typeof runner === 'function';
  }

  /** 生成执行计划(挂载根取自 ctx.trustedRoot),便于测试与审阅而不真正运行。 */
  plan(spec: SandboxSpec, ctx: SandboxExecContext = {}): VmPlan {
    const mountRoot = ctx.trustedRoot || '<trusted-root>';
    return buildPlan(this.vmBackend, spec, mountRoot);
  }

  /** 执行:未 provision 抛 501(绝不退回无隔离进程);否则生成计划并交 runner 运行。 */
  async exec(spec: SandboxSpec, ctx: SandboxExecContext = {}): Promise<unknown> {
    if (!this._provisioned || typeof this._runner !== 'function') {
      const error = new Error(
        `vm sandbox backend "${this.vmBackend}" is not provisioned on this machine; `
        + 'install the backend and inject a runner, or use the local backend',
      ) as HttpError;
      error.statusCode = 501;
      throw error;
    }
    const planned = this.plan(spec, ctx);
    return this._runner(planned, spec, ctx);
  }
}
