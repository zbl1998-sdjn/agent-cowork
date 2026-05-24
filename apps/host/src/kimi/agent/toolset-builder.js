import { createAgentTools } from '../agent-tools.js';
import { runRecipe } from '../../recipes/run-recipe.js';

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
  if (agentDeps.approvals) tools.push(createAskUserQuestionTool(agentDeps));
  if (agentDeps.scheduler) tools.push(createScheduleTaskTool(ctx, agentDeps));
  tools.push(createSubAgentTool({ ctx, runDeps, agentDeps, baseTools }));
  return tools;
}

function createAskUserQuestionTool(agentDeps) {
  const emit = typeof agentDeps.emit === 'function' ? agentDeps.emit : () => {};
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
      const { id, promise } = agentDeps.approvals.request({ kind: 'question', question, options, runId: agentDeps.runId });
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
