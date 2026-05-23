// VM sandbox adapter (contract).
//
// This is the extensible target that delivers Claude-Cowork-grade isolation:
// run the tool inside a lightweight Linux VM / container with the trusted root
// mounted and the network OFF by default. It shares the `exec(spec, ctx)`
// interface with LocalSubprocessSandbox, so swapping backends never touches the
// route or call sites.
//
// Supported backends (provisioned at deploy time, not here):
//   - 'wsl'    : `wsl.exe -d <distro> -- <tool> <args>` with the workspace
//                bind-mounted; network controlled via the distro's netns.
//   - 'docker' : `docker run --network=none -v <root>:/work -w /work <image>`.
//   - 'hyperv' : a managed micro-VM with a 9p/virtiofs workspace share.
//
// Until a backend is provisioned on the machine, `exec` fails fast with a clear
// message rather than silently falling back to an unisolated process — the
// whole point of this adapter is the isolation guarantee.

function buildPlan(backend, spec, mountRoot) {
  switch (backend) {
    case 'docker':
      return {
        argv: [
          'docker', 'run', '--rm',
          spec.network ? '--network=bridge' : '--network=none',
          '-v', `${mountRoot}:/work`,
          '-w', '/work',
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

export class VmSandbox {
  constructor({ backend = 'docker', image = null, distro = null, provisioned = false, runner = null } = {}) {
    this.backend = `vm:${backend}`;
    this.vmBackend = backend;
    this.image = image;
    this.distro = distro;
    this.networkIsolated = backend !== 'wsl';
    // `runner` lets a deployment inject a concrete spawn-based executor while
    // keeping this module pure/testable. When absent we treat the VM as
    // not provisioned.
    this._runner = runner;
    this._provisioned = provisioned && typeof runner === 'function';
  }

  /** Describe (without running) the command plan for a spec — useful for previews/tests. */
  plan(spec, ctx = {}) {
    const mountRoot = ctx.trustedRoot || '<trusted-root>';
    return buildPlan(this.vmBackend, spec, mountRoot);
  }

  async exec(spec, ctx = {}) {
    if (!this._provisioned) {
      const error = new Error(
        `vm sandbox backend "${this.vmBackend}" is not provisioned on this machine; `
        + 'install the backend and inject a runner, or use the local backend',
      );
      error.statusCode = 501;
      throw error;
    }
    const planned = this.plan(spec, ctx);
    return this._runner(planned, spec, ctx);
  }
}
