// Agent tool shared contracts(host · L1 领域层):只放类型,不引入运行依赖。

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
