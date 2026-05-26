// @ts-check
import { createAgentTools } from '../agent-tools.js';
import { runRecipe } from '../../recipes/run-recipe.js';
import { createParallelSubAgentTool } from './parallel-agent-tool.js';

/**
 * @typedef {Record<string, unknown>} ToolArgs
 * @typedef {{ name: string, risk?: string, mutating?: boolean, description?: string, parameters?: unknown, handler?: (args?: ToolArgs) => unknown | Promise<unknown> }} AgentTool
 * @typedef {{ name?: unknown, source?: unknown, description?: unknown, inputSchema?: { type?: unknown } & Record<string, unknown> }} ToolDescriptor
 * @typedef {{ list(): unknown[], call(name: string, args: unknown, context: Record<string, unknown>): unknown | Promise<unknown> }} ToolRegistry
 * @typedef {{ enabled?: boolean }} SkillDescriptor
 * @typedef {{ get(id: unknown): SkillDescriptor | null | undefined }} SkillRegistry
 * @typedef {{ tenantId?: unknown, userId?: unknown, traceId?: unknown, [key: string]: unknown }} RequestContext
 * @typedef {{ trustedRoot: string, context?: RequestContext, sandbox?: unknown, sandboxLimits?: unknown }} ToolsetContext
 * @typedef {{ runStoreRoot?: string, runEvents?: unknown, runsIndex?: unknown }} RunDeps
 * @typedef {{ request(payload: Record<string, unknown>): { id: string, promise: Promise<unknown> } }} ApprovalRegistry
 * @typedef {{ create(args: Record<string, unknown>): { id: unknown, name: unknown, kind: unknown, nextFireAt?: unknown, cronHuman?: unknown } }} Scheduler
 * @typedef {{ approvals?: ApprovalRegistry | null, scheduler?: Scheduler | null, emit?: (type: string, payload: Record<string, unknown>) => void, runId?: unknown, runAgentChat?: (args: Record<string, unknown>) => Promise<{ text?: unknown, steps: unknown[] }>, kimiConfig?: unknown, modelCall?: unknown, autoApprove?: unknown, auditBus?: unknown, hooks?: unknown }} AgentDeps
 * @typedef {{ ctx: ToolsetContext, toolRegistry?: ToolRegistry | null, skillRegistry?: SkillRegistry | null, runDeps?: RunDeps, agentDeps?: AgentDeps | null }} BuildToolsetOptions
 * @typedef {{ ctx: ToolsetContext, runDeps: RunDeps, agentDeps: AgentDeps, baseTools: AgentTool[] }} SubAgentToolOptions
 */

/** @param {BuildToolsetOptions} options @returns {AgentTool[]} */
export function buildAgentToolset({ ctx, toolRegistry, skillRegistry, runDeps = {}, agentDeps = null }) {
  const tools = createAgentTools(/** @type {Parameters<typeof createAgentTools>[0]} */ (ctx));
  if (toolRegistry && typeof toolRegistry.list === 'function') {
    for (const rawDescriptor of toolRegistry.list()) {
      const descriptor = /** @type {ToolDescriptor} */ (rawDescriptor && typeof rawDescriptor === 'object' ? rawDescriptor : {});
      if (!descriptor.source || !String(descriptor.source).startsWith('mcp:')) continue;
      const name = String(descriptor.name || '').trim();
      if (!name) continue;
      tools.push({
        name,
        risk: 'high',
        mutating: true,
        description: String(descriptor.description || `外部连接器工具 ${name}`),
        parameters: descriptor.inputSchema?.type ? descriptor.inputSchema : { type: 'object', properties: {} },
        handler: (args) => toolRegistry.call(name, args, { trustedRoot: ctx.trustedRoot, context: ctx.context || {} }),
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
          recipeId: String(args.id || ''),
          trustedRoot: ctx.trustedRoot,
          prompt: args.prompt || '',
          context: ctx.context || {},
          runStoreRoot: runDeps.runStoreRoot || '',
          runEvents: /** @type {Parameters<typeof runRecipe>[0]['runEvents']} */ (runDeps.runEvents || null),
          runsIndex: /** @type {Parameters<typeof runRecipe>[0]['runsIndex']} */ (runDeps.runsIndex || null),
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

/** @param {AgentDeps} agentDeps @param {ToolsetContext} ctx @returns {AgentTool} */
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
        .map((o) => {
          const option = /** @type {{ label?: unknown, description?: unknown }} */ (o && typeof o === 'object' ? o : {});
          return typeof o === 'string' ? { label: o } : { label: String(option.label || ''), description: option.description || '' };
        })
        .filter((o) => o.label);
      if (!agentDeps.approvals) return { error: 'approval registry unavailable' };
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

/** @param {ToolsetContext} ctx @param {AgentDeps} agentDeps @returns {AgentTool} */
function createScheduleTaskTool(ctx, agentDeps) {
  return {
    name: 'ScheduleTask',
    risk: 'low',
    mutating: false,
    description: '为用户创建一个定时任务，到点自动运行。cron 用 5 段 crontab(分 时 日 月 周)做周期任务，或 fireAt 用未来 ISO 时间做一次性。必填 name；通常附 prompt(到点要做什么)或 recipeId。',
    parameters: { type: 'object', properties: { name: { type: 'string' }, cron: { type: 'string' }, fireAt: { type: 'string' }, prompt: { type: 'string' }, recipeId: { type: 'string' } }, required: ['name'] },
    handler: async (args = {}) => {
      try {
        if (!agentDeps.scheduler) return { error: 'scheduler unavailable' };
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
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** @param {SubAgentToolOptions} options @returns {AgentTool} */
function createSubAgentTool({ ctx, runDeps, agentDeps, baseTools }) {
  return {
    name: 'Agent',
    risk: 'low',
    description: '派生一个子 Agent 自主完成一个子任务（拥有同样的文件/命令工具）。用于把复杂任务拆解委派，返回子任务的结果摘要。',
    parameters: { type: 'object', properties: { task: { type: 'string', description: '交给子 Agent 的明确子任务' } }, required: ['task'] },
    handler: async (args = {}) => {
      if (typeof agentDeps.runAgentChat !== 'function') return { error: 'sub-agent runner unavailable' };
      /** @type {(args: Record<string, unknown>) => Promise<{ text?: unknown, steps: unknown[] }>} */
      const runAgentChat = agentDeps.runAgentChat;
      const sub = await runAgentChat({
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
