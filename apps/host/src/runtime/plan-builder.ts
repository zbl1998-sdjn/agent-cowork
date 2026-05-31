// 计划构建(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:计划模式——把自然语言目标转成有序的工具调用清单({ tool, args, rationale })而「不」执行。UI 展示计划、
//       用户批准后再由 runSubagent 执行。planner 可注入,默认实现可被真·模型 planner 替换。依赖:无(注入式)。
// Plan mode: propose a structured, approvable plan before executing it.
//
// buildPlan turns a natural-language goal into an ordered list of tool calls
// ({ tool, args, rationale }) WITHOUT running anything. The UI shows the plan,
// the user approves, and the steps are then executed via runSubagent. The
// planner is injectable so a real model-backed planner can replace the default
// heuristic (which simply maps the goal onto the most relevant registered tools
// via the registry's keyword search).

export type PlanToolHit = { name: string; source?: string };
export type PlanToolRegistry = { search(goal: string, options: { limit: number }): PlanToolHit[]; has(tool: string): boolean };
export type PlanStep = { tool: string; args?: Record<string, unknown>; rationale?: string };
export type BuiltPlan = { goal: string; steps: PlanStep[]; executable: boolean };
export type PlannerOutput = { goal?: string; steps?: unknown[] };
export type Planner = (input: { goal: string; registry: PlanToolRegistry; limit: number }) => PlannerOutput | Promise<PlannerOutput>;

/**
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
 */
function isExecutableStep(step: unknown, registry: PlanToolRegistry): step is PlanStep {
  if (!step || typeof step !== 'object') return false;
  const source = step as Record<string, unknown>;
  return typeof source.tool === 'string' && registry.has(source.tool);
}

/**
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
  // Keep only steps whose tool actually exists, so an approved plan is always
  // executable by runSubagent.
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
