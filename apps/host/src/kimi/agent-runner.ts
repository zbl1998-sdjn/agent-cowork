// Agent 运行入口的兼容门面:把 Agent 循环/工具组装等能力再导出(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:保持向后兼容——老调用方继续从 kimi/agent-runner.js 导入,而真正实现已拆到
//       agent/* 小模块(tool-loop、toolset-builder、model-resilience、model-call)。
// 依赖:同层 ./model-call.js、./agent/tool-loop.js、./agent/toolset-builder.js、
//       ./agent/model-resilience.js。
// 导出:defaultAgentModelCall、runAgentChat、callModelResilient、friendlyAgentError、
//       modelBreakerStats、buildAgentToolset。
import { defaultAgentModelCall } from './model-call.js';
import { runAgentChat } from './agent/tool-loop.js';
import { buildAgentToolset as baseBuildAgentToolset } from './agent/toolset-builder.js';
import { omitUndefined } from '../util/object.js';
import type { RunAgentChatOptions } from './agent/tool-loop.js';
import type { AgentDeps, BuildToolsetOptions } from './agent/toolset-builder.js';

// 兼容门面:既有调用方继续从 kimi/agent-runner.js 导入,实现则已经拆进 agent/* 小模块。
export { defaultAgentModelCall };
export { runAgentChat };
export {
  callModelResilient,
  friendlyAgentError,
  modelBreakerStats,
} from './agent/model-resilience.js';

const defaultSubAgentRunner: NonNullable<AgentDeps['runAgentChat']> = (args) => (
  runAgentChat(args as unknown as RunAgentChatOptions)
);

/** 组装 Agent 可用的工具集;若未提供子 Agent 运行器则默认用本地 runAgentChat。 */
export function buildAgentToolset(options: BuildToolsetOptions) {
  const agentDeps = options?.agentDeps
    ? { ...options.agentDeps, runAgentChat: options.agentDeps.runAgentChat || defaultSubAgentRunner }
    : options?.agentDeps;
  return baseBuildAgentToolset(omitUndefined({ ...options, agentDeps }));
}
