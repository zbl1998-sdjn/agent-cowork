import { createAgentTools } from '../agent-tools.js';
import { runRecipe } from '../../recipes/run-recipe.js';

const DEFAULT_PARALLEL_AGENT_BUDGET_BYTES = 32 * 1024;
const DEFAULT_PARALLEL_AGENT_MAX_TASKS = 8;
const DEFAULT_PARALLEL_AGENT_CONCURRENCY = 3;

export function buildAgentToolset({ ctx, toolRegistry, skillRegistry, runDeps = {}, agentDeps = null }) {
  const tools = createAgentTools(ctx);
  if (toolRegistry && typeof toolRegistry.list === 'function') {
    for (const descriptor of toolRegistry.list()) {
      if (!descriptor.source || !String(descriptor.source).startsWith('mcp:')) continue;
      tools.push({
        name: descriptor.name,
        risk: 'high',
        mutating: true,
        description: descriptor.description || `外部连接器工具 ${descriptor.name}`,
        parameters: descriptor.inputSchema?.type ? descriptor.inputSchema : { type: 'object', properties: {} },
        handler: (args) => toolRegistry.call(descriptor.name, args, { trustedRoot: ctx.trustedRoot, context: ctx.context }),
      });
    }
  }
  if (skillRegistry && typeof skillRegistry.get === 'function') {
    tools.push({
      name: 'Skill',
      risk: 'low',
      description: '运行一个已启用的内置 skill（按 id），生成可审批的产物计划。',
      parameters: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' } }, required: ['id'] },
      handler: async (args = {}) => {
        const skill = skillRegistry.get(args.id);
        if (!skill || !skill.enabled) return { error: `skill not available: ${args.id}` };
        const result = runRecipe({
          recipeId: args.id,
          trustedRoot: ctx.trustedRoot,
          prompt: args.prompt || '',
          context: ctx.context,
          runStoreRoot: runDeps.runStoreRoot,
          runEvents: runDeps.runEvents,
          runsIndex: runDeps.runsIndex,
        });
        return { skill: args.id, operations: result.operations.length, runId: result.runId };
      },
    });
  }
  if (!agentDeps) return tools;

  const baseTools = tools.slice();
  if (agentDeps.approvals) tools.push(createAskUserQuestionTool(agentDeps, ctx));
  if (agentDeps.scheduler) tools.push(createScheduleTaskTool(ctx, agentDeps));
  tools.push(createSubAgentTool({ ctx, runDeps, agentDeps, baseTools }));
  tools.push(createParallelSubAgentTool({ ctx, runDeps, agentDeps, baseTools }));
  return tools;
}

function createAskUserQuestionTool(agentDeps, ctx) {
  const emit = typeof agentDeps.emit === 'function' ? agentDeps.emit : () => {};
  const context = (ctx && ctx.context) || {};
  return {
    name: 'AskUserQuestion',
    risk: 'safe',
    mutating: false,
    description: '需要用户澄清或在几个方案间做选择时，向用户提一个带选项的问题并等待回答后再继续。参数 question(问题文本)、options(可选, 字符串或 {label,description} 数组)。返回 { answer }。',
    parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] },
    handler: async (args = {}) => {
      const question = String((args && args.question) || '').trim();
      if (!question) return { error: 'question is required' };
      const options = (Array.isArray(args.options) ? args.options : [])
        .slice(0, 8)
        .map((o) => (typeof o === 'string' ? { label: o } : { label: String((o && o.label) || ''), description: (o && o.description) || '' }))
        .filter((o) => o.label);
      const { id, promise } = agentDeps.approvals.request({
        kind: 'question',
        question,
        options,
        runId: agentDeps.runId,
        ...(context.tenantId ? { tenantId: context.tenantId } : {}),
        ...(context.userId ? { userId: context.userId } : {}),
      });
      emit('question', { id, question, options });
      const answer = await promise;
      return { answer: typeof answer === 'string' ? answer : String(answer == null ? '' : answer) };
    },
  };
}

function createScheduleTaskTool(ctx, agentDeps) {
  return {
    name: 'ScheduleTask',
    risk: 'low',
    mutating: false,
    description: '为用户创建一个定时任务，到点自动运行。cron 用 5 段 crontab(分 时 日 月 周)做周期任务，或 fireAt 用未来 ISO 时间做一次性。必填 name；通常附 prompt(到点要做什么)或 recipeId。',
    parameters: { type: 'object', properties: { name: { type: 'string' }, cron: { type: 'string' }, fireAt: { type: 'string' }, prompt: { type: 'string' }, recipeId: { type: 'string' } }, required: ['name'] },
    handler: async (args = {}) => {
      try {
        const record = agentDeps.scheduler.create({
          name: args.name,
          cron: args.cron || null,
          fireAt: args.fireAt || null,
          payload: { prompt: args.prompt || '', recipeId: args.recipeId || null, trustedRoot: ctx.trustedRoot },
          tenantId: ctx.context && ctx.context.tenantId,
          userId: ctx.context && ctx.context.userId,
          traceId: ctx.context && ctx.context.traceId,
        });
        return { id: record.id, name: record.name, kind: record.kind, nextFireAt: record.nextFireAt, cronHuman: record.cronHuman || null };
      } catch (err) {
        return { error: err.message };
      }
    },
  };
}

function createSubAgentTool({ ctx, runDeps, agentDeps, baseTools }) {
  return {
    name: 'Agent',
    risk: 'low',
    description: '派生一个子 Agent 自主完成一个子任务（拥有同样的文件/命令工具）。用于把复杂任务拆解委派，返回子任务的结果摘要。',
    parameters: { type: 'object', properties: { task: { type: 'string', description: '交给子 Agent 的明确子任务' } }, required: ['task'] },
    handler: async (args = {}) => {
      if (typeof agentDeps.runAgentChat !== 'function') return { error: 'sub-agent runner unavailable' };
      const sub = await agentDeps.runAgentChat({
        prompt: String(args.task || ''),
        kimiConfig: agentDeps.kimiConfig,
        trustedRoot: ctx.trustedRoot,
        tools: baseTools,
        modelCall: agentDeps.modelCall,
        maxSteps: 4,
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
        context: ctx.context,
      });
      return { text: sub.text, steps: sub.steps.length };
    },
  };
}

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
  if (tasks.length === 0) {
    return { error: 'tasks must be a non-empty array' };
  }
  if (tasks.length > maxTasks) {
    return { error: `too many parallel sub-agent tasks; max ${maxTasks}` };
  }
  const budget = Math.max(1, Number(args.contextBudgetBytes) || DEFAULT_PARALLEL_AGENT_BUDGET_BYTES);
  const contextBytes = Buffer.byteLength(JSON.stringify({ tasks }), 'utf8');
  if (contextBytes > budget) {
    return { error: `parallel sub-agent context budget exceeded (${contextBytes}/${budget} bytes)` };
  }
  return { contextBytes, contextBudgetBytes: budget, maxTasks };
}

function createParallelSubAgentTool({ ctx, runDeps, agentDeps, baseTools }) {
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
      const children = new Array(tasks.length);
      let next = 0;
      async function worker() {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= tasks.length) return;
          const task = tasks[index];
          try {
            const sub = await agentDeps.runAgentChat({
              prompt: task.task,
              kimiConfig: agentDeps.kimiConfig,
              trustedRoot: ctx.trustedRoot,
              tools: baseTools,
              modelCall: agentDeps.modelCall,
              maxSteps: Math.max(1, Number(args.maxSteps) || 4),
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
          } catch (err) {
            children[index] = {
              index,
              task: task.task,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
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
