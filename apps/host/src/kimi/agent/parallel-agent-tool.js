const DEFAULT_PARALLEL_AGENT_BUDGET_BYTES = 32 * 1024;
const DEFAULT_PARALLEL_AGENT_MAX_TASKS = 8;
const DEFAULT_PARALLEL_AGENT_CONCURRENCY = 3;

function normalizeParallelAgentTasks(args = {}) {
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
        : String(task?.task || task?.goal || '').trim(),
    }))
    .filter((task) => task.task);
}

function enforceParallelAgentBudget(tasks, args = {}) {
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

export function createParallelSubAgentTool({ ctx, runDeps, agentDeps, baseTools }) {
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
      const tasks = normalizeParallelAgentTasks(args);
      const limits = enforceParallelAgentBudget(tasks, args);
      if (limits.error) return { error: limits.error };
      const concurrency = Math.max(
        1,
        Math.min(Number(args.maxConcurrency) || DEFAULT_PARALLEL_AGENT_CONCURRENCY, tasks.length),
      );
      const maxSteps = Math.max(1, Number(args.maxSteps) || 4);
      const emitChild = (type, payload) => {
        if (typeof agentDeps.emit === 'function') agentDeps.emit(type, payload);
      };
      const children = new Array(tasks.length);
      let next = 0;
      async function worker() {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= tasks.length) return;
          const task = tasks[index];
          emitChild('child_start', { index, goal: task.task, stepCount: maxSteps });
          try {
            const sub = await agentDeps.runAgentChat({
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
            children[index] = { index, task: task.task, ok: true, text: sub.text, steps: sub.steps.length };
            emitChild('child_end', { index, goal: task.task, status: 'succeeded', stepCount: sub.steps.length });
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
