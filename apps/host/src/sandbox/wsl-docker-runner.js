// @ts-check
//
// WSL/Docker 运行器(host · L1 领域层 · sandbox)
// ---------------------------------------------------------------------------
// 职责:VM 后端的真实 spawn 执行器。把归一化 SandboxSpec 翻译成具体隔离命令行,交给共享的
//       受约束子进程执行。注入进 VmSandbox,使适配器保持纯净、本模块可用 fake spawn 单测。
//       docker:--network=none 是真断网保证;wsl 默认共享宿主网络,故只报 networkIsolated:false 并告警。
// 依赖:node:child_process + 同层 exec-child。导出:createWslDockerRunner。
//
// Real spawn-based runner for the VM sandbox backends.
//
// Turns a normalised SandboxSpec into a concrete, isolated command line and
// runs it through the shared constrained-child executor. Injected into
// `VmSandbox` so the adapter stays pure and this stays unit-testable with a
// fake spawn.
//
//   docker : docker run --rm --network=none -v <root>:/work -w /work \
//            [-e K=V ...] <image> <tool> <args...>
//   wsl    : wsl.exe [-d <distro>] -- <tool> <args...>
//
// Network: docker maps `network:false` -> `--network=none` (a real guarantee).
// wsl shares the host network unless the distro is configured otherwise, so we
// report `networkIsolated:false` and warn — never claim a guarantee we cannot
// keep.
import childProcess from 'node:child_process';
import { runConstrainedChild } from './exec-child.js';

/**
 * @typedef {import('./sandbox-spec.js').SandboxSpec} SandboxSpec
 * @typedef {import('./exec-child.js').SpawnLike} SpawnLike
 * @typedef {Error & { statusCode?: number }} HttpError
 * @typedef {{ trustedRoot?: string, context?: Record<string, unknown> }} SandboxExecContext
 * @typedef {{ backend?: string, image?: string | null, distro?: string | null, spawn?: SpawnLike }} WslDockerRunnerOptions
 * @typedef {{ backend: string, exitCode: number, signal: string | null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, bytesStdout: number, bytesStderr: number, durationMs: number, networkIsolated: boolean, warnings: string[], argv: string[] }} WslDockerRunResult
 */

/** @param {Record<string, string>} env @returns {string[]} */
function dockerEnvFlags(env) {
  /** @type {string[]} */
  const flags = [];
  for (const [key, value] of Object.entries(env || {})) {
    flags.push('-e', `${key}=${value}`);
  }
  return flags;
}

/** 据后端拼出真实命令行 argv:docker(挂载/断网/env/镜像)或 wsl(可选 -d distro);缺镜像/未知后端抛 501。 @param {string} backend @param {SandboxSpec} spec @param {SandboxExecContext} ctx @param {{ image?: string | null, distro?: string | null }} options @returns {string[]} */
function buildArgv(backend, spec, ctx, { image, distro }) {
  const mountRoot = ctx.trustedRoot;
  if (backend === 'docker') {
    if (!image) {
      const error = /** @type {HttpError} */ (new Error('docker sandbox requires an image (set sandbox image)'));
      error.statusCode = 501;
      throw error;
    }
    return [
      'docker', 'run', '--rm',
      spec.network ? '--network=bridge' : '--network=none',
      '-v', `${mountRoot}:/work`,
      '-w', '/work',
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
  const error = /** @type {HttpError} */ (new Error(`unsupported vm backend "${backend}"`));
  error.statusCode = 501;
  throw error;
}

/**
 * 创建可注入 VmSandbox({ runner }) 的执行器:按后端拼命令行并经受约束子进程运行,回传结果+网络隔离实情。
 * Create a runner suitable for `VmSandbox({ runner })`.
 *
 * @param {WslDockerRunnerOptions} options { backend, image, distro, spawn }
 * @returns {(plan: unknown, spec: SandboxSpec, ctx?: SandboxExecContext) => Promise<WslDockerRunResult>}
 */
export function createWslDockerRunner(options = {}) {
  const backend = String(options.backend || 'docker').toLowerCase();
  const image = options.image || null;
  const distro = options.distro || null;
  const spawn = options.spawn || childProcess.spawn;
  const networkBacked = backend === 'docker';

  return async function runner(_plan, spec, ctx = {}) {
    if (!ctx.trustedRoot) {
      throw new Error('vm runner: trustedRoot is required');
    }
    const argv = buildArgv(backend, spec, ctx, { image, distro });
    const warnings = [];
    const networkIsolated = networkBacked ? !spec.network : false;
    if (!networkIsolated && !spec.network) {
      warnings.push(`${backend} backend does not guarantee network isolation in this configuration`);
    }

    const core = await runConstrainedChild({
      spawn,
      command: argv[0],
      args: argv.slice(1),
      // The container/distro provides the real cwd (/work); on the host side we
      // launch the wrapper from the mounted root.
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
