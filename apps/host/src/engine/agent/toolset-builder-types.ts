// Agent 工具集构建的纯类型契约(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:集中工具注册表、运行依赖与构建参数结构，供路由和行为模块共同引用。
// 依赖:仅同层审批门禁类型，无运行时依赖。
import type { AgentTool } from './approval-gate-types.js';

export type ToolRegistry = {
  list(): unknown[];
  call(name: string, args: unknown, context: Record<string, unknown>): unknown | Promise<unknown>;
};
export type SkillDescriptor = { enabled?: boolean };
export type SkillRegistry = { get(id: unknown): SkillDescriptor | null | undefined };
// SKILL.md 标准技能包读取器(由路由层用 skills/skill-md-loader 构造后注入,避免领域层互相 import)。
export type SkillPackReader = {
  list(): Array<{ name: string; description: string }>;
  read(name: string, file?: string): { name: string; file: string; content: string };
};
export type RequestContext = { tenantId?: unknown; userId?: unknown; traceId?: unknown; [key: string]: unknown };
export type ToolsetContext = {
  trustedRoot: string;
  context?: RequestContext;
  sandbox?: unknown;
  sandboxLimits?: unknown;
};
export type RunDeps = { runStoreRoot?: string; runEvents?: unknown; runsIndex?: unknown };
export type ApprovalRegistry = {
  request(payload: Record<string, unknown>): { id: string; ready?: Promise<void>; promise: Promise<unknown> };
};
export type Scheduler = {
  create(args: Record<string, unknown>): {
    id: unknown;
    name: unknown;
    kind: unknown;
    nextFireAt?: unknown;
    cronHuman?: unknown;
  };
};
export type AgentDeps = {
  approvals?: ApprovalRegistry | null;
  workspaceApproved?: { has(name: string): boolean; add(name: string): void } | null;
  scheduler?: Scheduler | null;
  emit?: (type: string, payload: Record<string, unknown>) => void;
  runId?: unknown;
  runAgentChat?: (args: Record<string, unknown>) => Promise<{ text?: unknown; steps: unknown[] }>;
  modelConfig?: unknown;
  modelCall?: unknown;
  autoApprove?: unknown;
  planMode?: unknown;
  auditBus?: unknown;
  hooks?: unknown;
};
export type BuildToolsetOptions = {
  ctx: ToolsetContext;
  toolRegistry?: ToolRegistry | null;
  skillRegistry?: SkillRegistry | null;
  skillPackReader?: SkillPackReader | null;
  runDeps?: RunDeps;
  agentDeps?: AgentDeps | null;
};
export type SubAgentToolOptions = {
  ctx: ToolsetContext;
  runDeps: RunDeps;
  agentDeps: AgentDeps;
  baseTools: AgentTool[];
};
