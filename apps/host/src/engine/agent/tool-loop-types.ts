// Agent 主循环类型(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:集中放置 runAgentChat 的输入/输出契约,让 tool-loop.ts 保持编排职责。
import type { SkillDescriptor } from '../system-prompt.js';
import type { ApprovalRegistry, AuditBus, HookEngine, RequestContext } from './approval-gate.js';
import type { Checkpointer } from './checkpoint-state.js';
import type { Message as FinalizeMessage, Usage, UsageTotals } from './finalize.js';
import type { TrustedInProcessModelCallCapability } from './model-call-capability.js';
import type { ModelCall } from './model-call-types.js';
import type { RunTraceLike } from './run-trace-events.js';
import type { AgentTool, ContextManager as ToolResultContextManager, LoopGuard, RetryPolicy, ToolCall } from './tool-call-executor.js';

export type ModelConfig = Record<string, unknown> & { timeoutMs?: number };
export type ChatMessage = FinalizeMessage & { [key: string]: unknown };
export type ModelMessage = { content?: string; reasoning_content?: string; tool_calls?: ToolCall[]; usage?: Usage };
export type EmitFn = (type: string, payload: unknown) => void;
export type BudgetDecision = Record<string, unknown> & {
  shouldAbort?: boolean;
  limit?: unknown;
  actual?: unknown;
  maximum?: unknown;
  reason?: unknown;
  snapshot?: unknown;
};
export type BudgetGuardLike = {
  check(): BudgetDecision;
  recordUsage(usage?: Usage): BudgetDecision;
  stopMessage(decision?: BudgetDecision): string;
};
export type ContextPrepareResult = {
  messages?: ChatMessage[];
  compacted?: boolean;
  beforeTokens?: unknown;
  afterTokens?: unknown;
  keyFacts?: unknown[];
};
export type ContextManagerLike = {
  prepareMessages(messages: ChatMessage[]): ContextPrepareResult;
  formatToolResult: ToolResultContextManager['formatToolResult'];
};
export type ResumeState = { usage?: Usage; messages?: ChatMessage[]; approvedTools?: string[]; todos?: unknown[] };
export type RunAgentChatOptions = {
  prompt?: unknown; modelConfig?: ModelConfig; trustedRoot: string; tools?: AgentTool[]; modelCall?: ModelCall;
  inProcessModelCallCapability?: TrustedInProcessModelCallCapability; maxSteps?: number;
  approvals?: ApprovalRegistry | null; autoApprove?: boolean; planMode?: boolean; developerMode?: boolean; auditBus?: AuditBus | null; hooks?: HookEngine | null;
  memoryText?: string; skills?: SkillDescriptor[]; emit?: EmitFn; sandbox?: unknown; sandboxLimits?: unknown; runStoreRoot?: unknown; runEvents?: unknown; runsIndex?: unknown;
  context?: RequestContext; fetchImpl?: unknown; lazyTools?: AgentTool[]; verify?: boolean; maxVerifySteps?: number; signal?: AbortSignal | null; runId?: string | null; cacheKey?: string | null;
  userContent?: unknown; clarifyBeforeModel?: boolean; contextManager?: ContextManagerLike | null; contextOptions?: unknown; loopGuard?: LoopGuard | null; loopGuardOptions?: unknown;
  retryPolicy?: RetryPolicy | null; retryOptions?: unknown; budgetGuard?: BudgetGuardLike | null; runTimeoutMs?: number; checkpointer?: Checkpointer | null;
  resumeState?: ResumeState | null; runTrace?: RunTraceLike | null;
  // 步数收尾提醒触发比例(0/负数关闭)。默认走 STEP_BUDGET_NUDGE_RATIO(0.7)。
  stepNudgeRatio?: number;
  // 是否注入【工具使用纪律】收敛引导(默认 true)。false 可关闭(对照/特殊部署)。
  toolDiscipline?: boolean;
  // 单条消息任务太大跑满步数时,自动用新一窗步数续跑的次数(默认 0=不续跑)。
  // 硬上限 = maxSteps*(1+maxAutoContinues);预算/超时/循环护栏仍照常兜底。
  maxAutoContinues?: number;
};
export type RunAgentChatResult = {
  text: string;
  steps: Array<Record<string, unknown>>;
  usage: UsageTotals;
  cancelled: boolean;
  budgetStopped: boolean;
  timeoutStopped: boolean;
  // 因跑满(含自动续跑后的)步数硬上限而被截断(任务未自然收尾)。
  stepsExhausted: boolean;
  // 本次运行实际自动续跑了几窗。
  autoContinues: number;
};
