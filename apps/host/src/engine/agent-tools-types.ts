// Agent 工具共享类型契约(host · L1 领域层 · engine)
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
    options: { trustedRoot: string; context?: unknown; signal?: AbortSignal | null },
  ): Promise<{ exitCode?: unknown; stdout?: unknown; stderr?: unknown; timedOut?: unknown }>;
};
export type AgentToolsContext = {
  trustedRoot?: string;
  sandbox?: SandboxLike;
  sandboxLimits?: SandboxLimits;
  context?: unknown;
  /** 测试专用:注入 WebFetch 的底层 fetch 实现,不走真实网络。生产路径不传,走真实 fetch。 */
  fetchImpl?: unknown;
};
export type AgentTool = {
  name: string;
  mutating?: boolean;
  risk?: string;
  requiresApproval?: boolean;
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  approvalPreview?: (args: ToolArgs) => Record<string, unknown>;
  handler?: (args?: ToolArgs) => unknown | Promise<unknown>;
};
