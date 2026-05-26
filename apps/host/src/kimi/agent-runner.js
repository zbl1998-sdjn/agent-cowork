// @ts-check
import { defaultAgentModelCall } from './model-call.js';
import { runAgentChat } from './agent/tool-loop.js';
import { buildAgentToolset as baseBuildAgentToolset } from './agent/toolset-builder.js';

// Compatibility facade: existing callers keep importing from kimi/agent-runner.js
// while the implementation lives in small agent/* modules.
export { defaultAgentModelCall };
export { runAgentChat };
export {
  callModelResilient,
  friendlyAgentError,
  modelBreakerStats,
} from './agent/model-resilience.js';

/** @type {NonNullable<import('./agent/toolset-builder.js').AgentDeps['runAgentChat']>} */
const defaultSubAgentRunner = (args) => runAgentChat(/** @type {Parameters<typeof runAgentChat>[0]} */ (/** @type {unknown} */ (args)));

/** @param {import('./agent/toolset-builder.js').BuildToolsetOptions} options */
export function buildAgentToolset(options) {
  const agentDeps = options?.agentDeps
    ? { ...options.agentDeps, runAgentChat: options.agentDeps.runAgentChat || defaultSubAgentRunner }
    : options?.agentDeps;
  return baseBuildAgentToolset({ ...options, agentDeps });
}
