// 并行子代理工具(AgentParallel)(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:把若干互相独立的子任务并行派给子 Agent 执行(带并发上限与上下文字节预算),
//      逐个 emit child_start/child_end 事件,最后汇总每个子任务的成功文本或失败原因。
// 依赖:注入的 runAgentChat(递归跑子 Agent)、共享上下文/沙箱/审批/审计等依赖。
// 导出:createParallelSubAgentTool(返回一个 AgentTool 定义)
import type { AgentTool } from './approval-gate.js';

const DEFAULT_PARALLEL_AGENT_BUDGET_BYTES = 32 * 1024;
const DEFAULT_PARALLEL_AGENT_MAX_TASKS = 8;
const DEFAULT_PARALLEL_AGENT_CONCURRENCY = 3;

type TaskLike = { task?: unknown; goal?: unknown };
type ParallelArgs = Record<string, unknown> & {
  tasks?: unknown;
  agents?: unknown;
  maxTasks?: unknown;
  contextBudgetBytes?: unknown;
  maxConcurrency?: unknown;
  maxSteps?: unknown;
};
type NormalizedTask = { index: number; task: string };
type ParallelLimits = {
  error?: string;
  contextBytes?: number;
  contextBudgetBytes?: number;
  maxTasks?: number;
};
type ParallelCtx = {
  trustedRoot: string;
  sandbox?: unknown;
  sandboxLimits?: unknown;
  context?: Record<string, unknown>;
};
type RunDeps = { runStoreRoot?: unknown; runEvents?: unknown; runsIndex?: unknown };
type RunAgentChat = (args: Record<string, unknown>) => Promise<{ text?: unknown; steps: unknown[] }>;
type AgentDeps = {
  runAgentChat?: RunAgentChat;
  kimiConfig?: unknown;
  modelCall?: unknown;
  approvals?: unknown;
  autoApprove?: unknown;
  auditBus?: unknown;
  hooks?: unknown;
  emit?: (type: string, payload: Record<string, unknown>) => void;
};
export type ParallelToolOptions = {
  ctx: ParallelCtx;
  runDeps: RunDeps;
  agentDeps: AgentDeps;
  baseTools: unknown[];
};
type ChildResult = {
  index: number;
  task: string;
  ok: boolean;
  text?: unknown;
  steps?: number;
  error?: string;
};

function normalizeParallelAgentTasks(args: ParallelArgs = {}): NormalizedTask[] {
  const rawTasks = Array.isArray(args.tasks)
    ? args.tasks
    : Array.isArray(args.agents)
      ? args.agents
      : [];
  return rawTasks
    .map((task, index) => ({
      index,
      task: typeof task === 'string'
        ? task.trim()
        : String((task && typeof task === 'object' ? task as TaskLike : {}).task || (task && typeof task === 'object' ? task as TaskLike : {}).goal || '').trim(),
    }))
    .filter((task) => task.task);
}

function enforceParallelAgentBudget(tasks: NormalizedTask[], args: ParallelArgs = {}): ParallelLimits {
  const maxTasks = Math.max(1, Number(args.maxTasks) || DEFAULT_PARALLEL_AGENT_MAX_TASKS);
  if (tasks.length === 0) return { error: 'tasks must be a non-empty array' };
  if (tasks.length > maxTasks) return { error: `too many parallel sub-agent tasks; max ${maxTasks}` };
  const budget = Math.max(1, Number(args.contextBudgetBytes) || DEFAULT_PARALLEL_AGENT_BUDGET_BYTES);
  const contextBytes = Buffer.byteLength(JSON.stringify({ tasks }), 'utf8');
  if (contextBytes > budget) {
    return { error: `parallel sub-agent context budget exceeded (${contextBytes}/${budget} bytes)` };
  }
  return { contextBytes, contextBudgetBytes: budget, maxTasks };
}

/** 构造并行子代理工具:校验任务数与上下文预算,按并发上限派多个子 Agent 并汇总结果。 */
export function createParallelSubAgentTool({ ctx, runDeps, agentDeps, baseTools }: ParallelToolOptions): AgentTool {
  return {
    name: 'AgentParallel',
    risk: 'low',
    description: '并行派生多个子 Agent 处理互相独立的子任务，并返回每个子任务结果摘要。用于审查多个目录/文件夹或可并行研究任务。',
    parameters: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'string' }, description: '可并行执行的明确子任务列表' },
        maxConcurrency: { type: 'number', description: '并发上限，默认 3' },
      },
      required: ['tasks'],
    },
    handler: async (args = {}) => {
      if (typeof agentDeps.runAgentChat !== 'function') return { error: 'sub-agent runner unavailable' };
      const runAgentChat = agentDeps.runAgentChat;
      const input = args as ParallelArgs;
      const tasks = normalizeParallelAgentTasks(input);
      const limits = enforceParallelAgentBudget(tasks, input);
      if (limits.error) return { error: limits.error };
      const concurrency = Math.max(
        1,
        Math.min(Number(input.maxConcurrency) || DEFAULT_PARALLEL_AGENT_CONCURRENCY, tasks.length),
      );
      const maxSteps = Math.max(1, Number(input.maxSteps) || 4);
      const emitChild = (type: string, payload: Record<string, unknown>) => {
        if (typeof agentDeps.emit === 'function') agentDeps.emit(type, payload);
      };
      const children: ChildResult[] = new Array(tasks.length);
      let next = 0;
      async function worker() {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= tasks.length) return;
          const task = tasks[index];
          emitChild('child_start', { index, goal: task.task, stepCount: maxSteps });
          try {
            const sub = await runAgentChat({
              prompt: task.task,
              kimiConfig: agentDeps.kimiConfig,
              trustedRoot: ctx.trustedRoot,
              tools: baseTools,
              modelCall: agentDeps.modelCall,
              maxSteps,
              approvals: agentDeps.approvals,
              autoApprove: agentDeps.autoApprove,
              auditBus: agentDeps.auditBus,
              hooks: agentDeps.hooks,
              emit: agentDeps.emit,
              sandbox: ctx.sandbox,
              sandboxLimits: ctx.sandboxLimits,
              runStoreRoot: runDeps.runStoreRoot,
              runEvents: runDeps.runEvents,
              runsIndex: runDeps.runsIndex,
              context: { ...(ctx.context || {}), childIndex: index },
            });
            children[index] = { index, task: task.task, ok: true, text: sub.text, steps: Array.isArray(sub.steps) ? sub.steps.length : 0 };
            emitChild('child_end', { index, goal: task.task, status: 'succeeded', stepCount: Array.isArray(sub.steps) ? sub.steps.length : 0 });
          } catch (err) {
            children[index] = {
              index,
              task: task.task,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
            emitChild('child_end', { index, goal: task.task, status: 'failed', error: children[index].error });
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const ok = children.every((child) => child && child.ok);
      return {
        ok,
        children,
        limits: { ...limits, maxConcurrency: concurrency },
        summary: children
          .map((child) => `${child.index + 1}. ${child.task}: ${child.ok ? child.text : child.error}`)
          .join('\n'),
      };
    },
  };
}
