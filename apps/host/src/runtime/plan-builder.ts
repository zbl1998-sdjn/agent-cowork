// 计划构建(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:计划模式——把自然语言目标转成有序的工具调用清单({ tool, args, rationale })而「不」执行。UI 展示计划、
//       用户批准后再由 runSubagent 执行。planner 可注入,默认实现可被真·模型 planner 替换。依赖:无(注入式)。

export type PlanToolHit = { name: string; source?: string };
export type PlanToolRegistry = { search(goal: string, options: { limit: number }): PlanToolHit[]; has(tool: string): boolean };
export type PlanStep = { tool: string; args?: Record<string, unknown>; rationale?: string };
export type BuiltPlan = { goal: string; steps: PlanStep[]; executable: boolean };
export type PlannerOutput = { goal?: string; steps?: unknown[] };
export type Planner = (input: { goal: string; registry: PlanToolRegistry; limit: number }) => PlannerOutput | Promise<PlannerOutput>;

/**
 * 默认启发式 planner:只查 registry,生成待审批步骤,不触发任何工具执行。
 */
function defaultPlanner({ goal, registry, limit = 3 }: { goal: string; registry: PlanToolRegistry; limit?: number }): { goal: string; steps: PlanStep[] } {
  const hits = registry.search(goal, { limit });
  const steps = hits.map((tool) => ({
    tool: tool.name,
    args: tool.name.startsWith('recipe.') ? { prompt: goal } : {},
    rationale: `匹配工具 ${tool.name}（${tool.source || 'registry'}）`,
  }));
  return { goal, steps };
}

/**
 * 执行边界过滤:只有 registry 中真实存在的工具才能进入可审批计划。
 */
function isExecutableStep(step: unknown, registry: PlanToolRegistry): step is PlanStep {
  if (!step || typeof step !== 'object') return false;
  const source = step as Record<string, unknown>;
  return typeof source.tool === 'string' && registry.has(source.tool);
}

/**
 * 构建计划的唯一入口:校验目标、调用可注入 planner,并返回可由 runSubagent 执行的步骤子集。
 */
export async function buildPlan({
  goal,
  registry,
  planner = defaultPlanner,
  limit = 3,
}: {
  goal?: unknown;
  registry: PlanToolRegistry;
  planner?: Planner;
  limit?: number;
}): Promise<BuiltPlan> {
  if (!registry) {
    throw new Error('buildPlan: registry is required');
  }
  const text = String(goal || '').trim();
  if (!text) {
    const err = new Error('buildPlan: goal is required') as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  const plan = await planner({ goal: text, registry, limit });
  const rawSteps = Array.isArray(plan?.steps) ? plan.steps : [];
  // 只保留已注册工具,确保用户批准后的计划一定能交给 runSubagent 执行。
  const steps = rawSteps
    .filter((step) => isExecutableStep(step, registry))
    .map((step) => ({
      tool: String(step.tool),
      args: step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {},
      rationale: typeof step.rationale === 'string' ? step.rationale : '',
    }));
  return { goal: text, steps, executable: steps.length > 0 };
}

export { defaultPlanner };
