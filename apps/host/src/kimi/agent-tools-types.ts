// Agent 工具共享类型契约(host · L1 领域层 · kimi)
// ---------------------------------------------------------------------------
// 职责:集中放置 agent 工具集的输入/输出与沙箱契约(ToolArgs、SandboxLike、
//       AgentToolsContext、AgentTool 等),只声明类型、不引入任何运行期依赖,
//       让 agent-tools.ts 及各工具实现共享同一份接口定义。

export type ToolArgs = Record<string, unknown>;
export type SandboxLimits = { allowTools?: string[] };
export type SandboxLike = {
  backend?: string;
  exec(
    spec: unknown,
    options: { trustedRoot: string; context?: unknown },
  ): Promise<{ exitCode?: unknown; stdout?: unknown; stderr?: unknown; timedOut?: unknown }>;
};
export type AgentToolsContext = {
  trustedRoot?: string;
  sandbox?: SandboxLike;
  sandboxLimits?: SandboxLimits;
  context?: unknown;
};
export type AgentTool = {
  name: string;
  mutating?: boolean;
  risk?: string;
  requiresApproval?: boolean;
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  handler?: (args?: ToolArgs) => unknown | Promise<unknown>;
};
