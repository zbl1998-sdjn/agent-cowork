// Host sandbox limit wiring (host · L2 runtime helper).
import { DEFAULT_ALLOW_TOOLS } from '../sandbox/index.js';
import { omitUndefined } from '../util/object.js';
import type { HostConfig } from './host-state-types.js';

export function resolveHostSandboxLimits(config: HostConfig, env = process.env) {
  return omitUndefined({
    allowTools: config.sandboxAllowTools || [...DEFAULT_ALLOW_TOOLS],
    allowEnv: config.sandboxAllowEnv || [],
    allowUnrestrictedHostExecution: config.sandboxAllowUnrestrictedHostExecution ?? (env.KCW_ALLOW_UNRESTRICTED_HOST_EXECUTION === 'true'),
    maxTimeoutMs: config.sandboxMaxTimeoutMs,
    defaultMaxOutputBytes: config.sandboxMaxOutputBytes,
  });
}
