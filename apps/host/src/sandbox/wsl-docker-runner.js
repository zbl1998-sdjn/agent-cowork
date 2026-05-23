import childProcess from 'node:child_process';
import { runConstrainedChild } from './exec-child.js';

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

function dockerEnvFlags(env) {
  const flags = [];
  for (const [key, value] of Object.entries(env || {})) {
    flags.push('-e', `${key}=${value}`);
  }
  return flags;
}

function buildArgv(backend, spec, ctx, { image, distro }) {
  const mountRoot = ctx.trustedRoot;
  if (backend === 'docker') {
    if (!image) {
      const error = new Error('docker sandbox requires an image (set sandbox image)');
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
  const error = new Error(`unsupported vm backend "${backend}"`);
  error.statusCode = 501;
  throw error;
}

/**
 * Create a runner suitable for `VmSandbox({ runner })`.
 *
 * @param {object} options { backend, image, distro, spawn }
 * @returns {(plan, spec, ctx) => Promise<result>}
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
