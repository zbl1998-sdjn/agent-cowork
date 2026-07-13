// WSL/Docker 运行器(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:VM 后端的真实 spawn 执行器。把归一化 SandboxSpec 翻译成具体隔离命令行,交给共享的
//       受约束子进程执行。注入进 VmSandbox,使适配器保持纯净、本模块可用 fake spawn 单测。
//       docker:不可变镜像+最小权限/资源上限/默认只读与断网;wsl 默认共享宿主网络,
//       故只报 networkIsolated:false 并告警。
// 依赖:node:child_process + 同层 exec-child。导出:createWslDockerRunner。
import childProcess from 'node:child_process';
import { runConstrainedChild } from './exec-child.js';
import type { RunChildResult, SpawnLike } from './exec-child.js';
import type { SandboxSpec } from './sandbox-spec.js';

type HttpError = Error & { statusCode?: number };
export type SandboxExecContext = { trustedRoot?: string; context?: Record<string, unknown> };
export type WslDockerRunnerOptions = {
  backend?: string;
  image?: string | null;
  distro?: string | null;
  spawn?: SpawnLike;
};
export type WslDockerRunResult = RunChildResult & {
  backend: string;
  networkIsolated: boolean;
  warnings: string[];
  argv: string[];
};
export type WslDockerRunner = (plan: unknown, spec: SandboxSpec, ctx?: SandboxExecContext) => Promise<WslDockerRunResult>;

const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
const NAMED_IMAGE_DIGEST_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;

/** 只接受本地内容 ID 或规范化 repository@sha256 digest;拒绝 tag 与 option-like 输入。 */
export function isImmutableDockerImage(image: string): boolean {
  return IMAGE_ID_RE.test(image) || NAMED_IMAGE_DIGEST_RE.test(image);
}

function dockerUserFlag(): string {
  const identity = process as typeof process & { getuid?: () => number; getgid?: () => number };
  const hostUid = typeof identity.getuid === 'function' ? identity.getuid() : null;
  const hostGid = typeof identity.getgid === 'function' ? identity.getgid() : null;
  const uid = Number.isSafeInteger(hostUid) && Number(hostUid) > 0 ? Number(hostUid) : 65532;
  const gid = Number.isSafeInteger(hostGid) && Number(hostGid) > 0 ? Number(hostGid) : 65532;
  return `--user=${uid}:${gid}`;
}

/** Docker 安全基线。常量预算防止请求扩大资源;workspace 写入只来自已归一化的显式能力。 */
export function dockerSandboxFlags(spec: SandboxSpec, mountRoot: string): string[] {
  return [
    '--pull=never',
    spec.network ? '--network=bridge' : '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    dockerUserFlag(),
    '--pids-limit=128',
    '--memory=512m',
    '--memory-swap=512m',
    '--cpus=1',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
    '--volume', `${mountRoot}:/work:${spec.workspaceWrite ? 'rw' : 'ro'}`,
    '--workdir=/work',
  ];
}

function dockerEnvFlags(env: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(env || {})) {
    flags.push('-e', `${key}=${value}`);
  }
  return flags;
}

/** 据后端拼出真实命令行 argv:docker(挂载/断网/env/镜像)或 wsl(可选 -d distro);缺镜像/未知后端抛 501。 */
function buildArgv(
  backend: string,
  spec: SandboxSpec,
  ctx: SandboxExecContext,
  { image, distro }: { image?: string | null; distro?: string | null },
): string[] {
  const mountRoot = ctx.trustedRoot;
  if (!mountRoot) {
    throw new Error('vm runner: trustedRoot is required');
  }
  if (backend === 'docker') {
    if (!image) {
      const error = new Error('docker sandbox requires an image (set sandbox image)') as HttpError;
      error.statusCode = 501;
      throw error;
    }
    if (!isImmutableDockerImage(image)) {
      const error = new Error(
        'docker sandbox requires an immutable image digest '
        + '(use sha256:<64 lowercase hex> or <repository>@sha256:<64 lowercase hex>)',
      ) as HttpError;
      error.statusCode = 400;
      throw error;
    }
    return [
      'docker', 'run', '--rm',
      ...dockerSandboxFlags(spec, mountRoot),
      ...dockerEnvFlags(spec.env),
      image,
      spec.tool,
      ...spec.args,
    ];
  }
  if (backend === 'wsl') {
    const base = distro ? ['wsl.exe', '-d', distro, '--'] : ['wsl.exe', '--'];
    return [...base, spec.tool, ...spec.args];
  }
  const error = new Error(`unsupported vm backend "${backend}"`) as HttpError;
  error.statusCode = 501;
  throw error;
}

/** 创建可注入 VmSandbox({ runner }) 的执行器:按后端拼命令行并经受约束子进程运行,回传结果+网络隔离实情。 */
export function createWslDockerRunner(options: WslDockerRunnerOptions = {}): WslDockerRunner {
  const backend = String(options.backend || 'docker').toLowerCase();
  const image = options.image || null;
  const distro = options.distro || null;
  const spawn = options.spawn || childProcess.spawn as SpawnLike;
  const networkBacked = backend === 'docker';

  return async function runner(_plan: unknown, spec: SandboxSpec, ctx: SandboxExecContext = {}): Promise<WslDockerRunResult> {
    if (!ctx.trustedRoot) {
      throw new Error('vm runner: trustedRoot is required');
    }
    if (backend === 'wsl' && spec.unrestrictedHostExecution !== true) {
      const error = new Error(
        'wsl backend cannot enforce workspace or host isolation; use Docker, or explicitly request unrestrictedHostExecution with an allowed capability',
      ) as HttpError;
      error.statusCode = 501;
      throw error;
    }
    const argv = buildArgv(backend, spec, ctx, { image, distro });
    const warnings: string[] = backend === 'wsl'
      ? ['unrestricted host execution is enabled; this process is not a read-only or OS-isolated sandbox']
      : [];
    const networkIsolated = networkBacked ? !spec.network : false;
    if (!networkIsolated && !spec.network) {
      warnings.push(`${backend} backend does not guarantee network isolation in this configuration`);
    }

    const core = await runConstrainedChild({
      spawn,
      command: argv[0] ?? '',
      args: argv.slice(1),
      // 容器/发行版内部提供真实 cwd(/work);宿主侧从挂载根启动 wrapper。
      cwd: ctx.trustedRoot,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
    });

    return {
      backend: `vm:${backend}`,
      ...core,
      networkIsolated,
      warnings,
      argv,
    };
  };
}
