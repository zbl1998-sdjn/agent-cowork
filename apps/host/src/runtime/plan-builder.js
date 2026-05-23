// Plan mode: propose a structured, approvable plan before executing it.
//
// buildPlan turns a natural-language goal into an ordered list of tool calls
// ({ tool, args, rationale }) WITHOUT running anything. The UI shows the plan,
// the user approves, and the steps are then executed via runSubagent. The
// planner is injectable so a real model-backed planner can replace the default
// heuristic (which simply maps the goal onto the most relevant registered tools
// via the registry's keyword search).

function defaultPlanner({ goal, registry, limit = 3 }) {
  const hits = registry.search(goal, { limit });
  const steps = hits.map((tool) => ({
    tool: tool.name,
    args: tool.name.startsWith('recipe.') ? { prompt: goal } : {},
    rationale: `匹配工具 ${tool.name}（${tool.source}）`,
  }));
  return { goal, steps };
}

export async function buildPlan({ goal, registry, planner = defaultPlanner, limit = 3 }) {
  if (!registry) {
    throw new Error('buildPlan: registry is required');
  }
  const text = String(goal || '').trim();
  if (!text) {
    const err = new Error('buildPlan: goal is required');
    err.statusCode = 400;
    throw err;
  }
  const plan = await planner({ goal: text, registry, limit });
  const rawSteps = Array.isArray(plan?.steps) ? plan.steps : [];
  // Keep only steps whose tool actually exists, so an approved plan is always
  // executable by runSubagent.
  const steps = rawSteps
    .filter((step) => step && typeof step.tool === 'string' && registry.has(step.tool))
    .map((step) => ({
      tool: step.tool,
      args: step.args && typeof step.args === 'object' ? step.args : {},
      rationale: typeof step.rationale === 'string' ? step.rationale : '',
    }));
  return { goal: text, steps, executable: steps.length > 0 };
}

export { defaultPlanner };
