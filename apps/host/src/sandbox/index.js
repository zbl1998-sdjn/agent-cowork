// @ts-check
// Sandbox factory + shared limits.
//
// createSandbox selects an adapter by backend. Both adapters implement the
// same exec(spec, ctx) contract, so callers (and the route) are
// backend-agnostic -- the Ports & Adapters seam for code/tool execution.

import { LocalSubprocessSandbox } from './local-sandbox.js';
import { VmSandbox } from './vm-sandbox.js';
import { createWslDockerRunner } from './wsl-docker-runner.js';
import { normalizeSandboxSpec, SANDBOX_DEFAULTS } from './sandbox-spec.js';

export { normalizeSandboxSpec, SANDBOX_DEFAULTS };
export { createWslDockerRunner };

// Conservative default tool allowlist: enough for "run this Python/Node to
// clean data" without exposing arbitrary host binaries. Extend via config.
export const DEFAULT_ALLOW_TOOLS = Object.freeze([
  'node',
  'python',
  'python3',
]);

const VM_BACKENDS = new Set(['vm', 'docker', 'wsl', 'hyperv']);

/**
 * @typedef {import('./exec-child.js').SpawnLike} SpawnLike
 * @typedef {import('./vm-sandbox.js').VmRunner} VmRunner
 * @typedef {{ backend?: string, vmBackend?: string, runner?: VmRunner | null, provisioned?: boolean, image?: string | null, distro?: string | null, spawn?: SpawnLike }} SandboxOptions
 */

/** @param {SandboxOptions} [options] */
export function createSandbox(options = {}) {
  const backend = String(options.backend || 'local').toLowerCase();

  if (backend === 'local' || backend === 'local-subprocess') {
    return new LocalSubprocessSandbox(options);
  }

  if (VM_BACKENDS.has(backend)) {
    const vmBackend = backend === 'vm' ? (options.vmBackend || 'docker') : backend;
    // A VM backend counts as "provisioned" only once we can actually run it:
    // an explicit runner, or enough config to build one (docker image / wsl).
    // Without that, VmSandbox fails fast (501) instead of pretending.
    let runner = options.runner || null;
    if (!runner) {
      const canProvision =
        options.provisioned === true ||
        (vmBackend === 'docker' && Boolean(options.image)) ||
        (vmBackend === 'wsl');
      if (canProvision) {
        runner = createWslDockerRunner({
          backend: vmBackend,
          image: options.image,
          distro: options.distro,
          spawn: options.spawn,
        });
      }
    }
    return new VmSandbox({
      backend: vmBackend,
      image: options.image,
      distro: options.distro,
      runner,
      provisioned: Boolean(runner),
    });
  }

  throw new Error(`createSandbox: unknown backend "${backend}"`);
}
