// 审批门禁的纯类型契约(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:集中门禁、钩子与审批注册表之间的结构类型，避免行为模块承担声明膨胀。
// 依赖:无运行时依赖。

export type ToolArgs = Record<string, unknown>;
export type AgentTool = {
  name: string;
  mutating?: boolean;
  risk?: string;
  requiresApproval?: boolean;
  description?: string;
  parameters?: unknown;
  approvalPreview?: (args: ToolArgs) => Record<string, unknown>;
  handler?: (args?: ToolArgs) => unknown | Promise<unknown>;
};
export type AuditBus = { publish(payload: Record<string, unknown>): unknown };
export type AuditFn = (kind: string, extra?: Record<string, unknown>) => void;
export type EmitFn = (type: string, payload: Record<string, unknown>) => void;
export type ToolCall = { id?: unknown };
export type StepList = Array<Record<string, unknown>>;
export type MessageList = Array<Record<string, unknown>>;
export type RequestContext = { tenantId?: unknown; userId?: unknown; [key: string]: unknown };
export type HookBlock = { reason?: string };
export type HookEngine = {
  run(event: string, payload: Record<string, unknown>): unknown | Promise<unknown>;
  blocked(result: unknown): false | HookBlock;
};
export type ApprovalRegistry = {
  request(payload: Record<string, unknown>): { id: string; ready?: Promise<void>; promise: Promise<string> };
};
export type PreToolHookOptions = {
  hooks?: HookEngine | null;
  name: string;
  args: ToolArgs;
  steps: StepList;
  audit: AuditFn;
  emit: EmitFn;
  messages: MessageList;
  call: ToolCall;
};
export type ExitPlanOptions = {
  name: string;
  args: ToolArgs;
  hasApprovals: boolean;
  autoApprove: boolean;
  approvals?: ApprovalRegistry | null;
  runId?: unknown;
  emit: EmitFn;
  audit: AuditFn;
  steps: StepList;
  messages: MessageList;
  call: ToolCall;
  context?: RequestContext;
};
export type PlanBlockOptions = {
  planMode: boolean;
  planApproved: boolean;
  needsApproval: boolean;
  name: string;
  tool?: AgentTool | null;
  steps: StepList;
  audit: AuditFn;
  emit: EmitFn;
  messages: MessageList;
  call: ToolCall;
};
export type ToolApprovalOptions = {
  needsApproval: boolean;
  hasApprovals: boolean;
  approvals?: ApprovalRegistry | null;
  sessionApproved: Set<string>;
  name: string;
  args: ToolArgs;
  tool: AgentTool;
  runId?: unknown;
  emit: EmitFn;
  audit: AuditFn;
  steps: StepList;
  messages: MessageList;
  call: ToolCall;
  autoApprove: boolean;
  planMode: boolean;
  planApproved: boolean;
  context?: RequestContext;
};
