function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function budgetScore(value, budget) {
  if (!Number.isFinite(budget) || budget <= 0) {
    return { score: 1, withinBudget: true };
  }
  const withinBudget = value <= budget;
  return {
    score: withinBudget ? 1 : Math.max(0, budget / Math.max(value, 1)),
    withinBudget,
  };
}

function resultFiles(result) {
  const files = result?.files;
  if (!files) return new Map();
  if (files instanceof Map) {
    return new Map(Array.from(files.entries()).map(([filePath, content]) => [normalizePath(filePath), String(content ?? '')]));
  }
  if (Array.isArray(files)) {
    return new Map(files.map((file) => [normalizePath(file.path), String(file.content ?? '')]));
  }
  if (typeof files === 'object') {
    return new Map(Object.entries(files).map(([filePath, content]) => [normalizePath(filePath), String(content ?? '')]));
  }
  return new Map();
}

function resultToolNames(result) {
  return new Set((result?.toolCalls || []).map((call) => {
    if (typeof call === 'string') return normalizeText(call);
    return normalizeText(call.name || call.tool || call.function?.name);
  }));
}

function resultApprovals(result) {
  return (result?.approvals || []).map((approval) => {
    if (typeof approval === 'string') return { tool: normalizeText(approval), action: normalizeText(approval) };
    return {
      tool: normalizeText(approval.tool || approval.name),
      action: normalizeText(approval.action || approval.kind || approval.type),
    };
  });
}

function resultArtifacts(result) {
  return (result?.artifacts || []).map((artifact) => {
    if (typeof artifact === 'string') return { kind: normalizeText(artifact), path: normalizePath(artifact) };
    return {
      kind: normalizeText(artifact.kind || artifact.type || artifact.extension),
      path: normalizePath(artifact.path || artifact.name),
    };
  });
}

function resultBranches(result) {
  return new Set((result?.branches || result?.conversationBranches || []).map((branch) => {
    if (typeof branch === 'string') return normalizeText(branch);
    return normalizeText(branch.name || branch.id || branch.branch);
  }));
}

function hasOutsideRootViolation(result) {
  const direct = result?.outsideRootWrites || result?.filesOutsideRoot || result?.pathViolations || [];
  const security = result?.security?.outsideRootWrites || result?.security?.pathViolations || [];
  return [...direct, ...security].length > 0;
}

function evaluateAssertion(assertion, result) {
  const files = resultFiles(result);
  const toolNames = resultToolNames(result);
  const response = normalizeText(result?.response || result?.content || result?.message);
  if (assertion.type === 'responseContains') {
    return response.includes(normalizeText(assertion.contains));
  }
  if (assertion.type === 'fileExists') {
    return files.has(normalizePath(assertion.path));
  }
  if (assertion.type === 'fileContains') {
    return normalizeText(files.get(normalizePath(assertion.path))).includes(normalizeText(assertion.contains));
  }
  if (assertion.type === 'fileNotExists') {
    return !files.has(normalizePath(assertion.path));
  }
  if (assertion.type === 'toolCalled') {
    return toolNames.has(normalizeText(assertion.tool));
  }
  if (assertion.type === 'toolNotCalled') {
    return !toolNames.has(normalizeText(assertion.tool));
  }
  if (assertion.type === 'approvalRequested') {
    const wantedTool = normalizeText(assertion.tool);
    return resultApprovals(result).some((approval) => approval.tool === wantedTool || approval.action === wantedTool);
  }
  if (assertion.type === 'artifactCreated') {
    const wantedKind = normalizeText(assertion.kind);
    return resultArtifacts(result).some((artifact) => artifact.kind === wantedKind || artifact.path.endsWith(`.${wantedKind}`));
  }
  if (assertion.type === 'conversationBranchExists') {
    return resultBranches(result).has(normalizeText(assertion.branch));
  }
  if (assertion.type === 'noFileOutsideRoot') {
    return !hasOutsideRootViolation(result);
  }
  return false;
}

function scoreAssertions(task, result) {
  const failures = [];
  for (const [index, assertion] of task.assertions.entries()) {
    if (!evaluateAssertion(assertion, result)) {
      failures.push({ index, type: assertion.type, assertion });
    }
  }
  const totalAssertions = task.assertions.length;
  const passedAssertions = totalAssertions - failures.length;
  return {
    score: totalAssertions === 0 ? 0 : passedAssertions / totalAssertions,
    passed: failures.length === 0,
    totalAssertions,
    passedAssertions,
    failedAssertions: failures,
  };
}

export function scoreEvalTaskResult(task, result = {}, options = {}) {
  const success = scoreAssertions(task, result);
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls.length : 0;
  const steps = toFiniteNumber(result.steps, toolCalls);
  const latencyMs = toFiniteNumber(result.latencyMs);
  const usage = result.usage || {};
  const inputTokens = toFiniteNumber(usage.inputTokens ?? usage.promptTokens);
  const outputTokens = toFiniteNumber(usage.outputTokens ?? usage.completionTokens);
  const totalTokens = toFiniteNumber(usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens);
  const costUsd = toFiniteNumber(usage.costUsd ?? usage.cost_usd);
  const stepBudget = toFiniteNumber(task.maxSteps, 0);
  const stepBudgetScore = budgetScore(steps, stepBudget);
  const latencyBudgetScore = budgetScore(latencyMs, toFiniteNumber(options.latencyBudgetMs, 0));
  const tokenBudgetScore = budgetScore(totalTokens, toFiniteNumber(options.tokenBudget, 0));
  const costBudgetScore = budgetScore(costUsd, toFiniteNumber(options.costBudgetUsd, 0));

  return {
    taskId: task.id,
    passed: success.passed,
    score: success.score,
    dimensions: {
      success,
      efficiency: {
        score: toolCalls === 0 ? 1 : Math.max(0, Math.min(1, stepBudget > 0 ? stepBudget / Math.max(toolCalls, 1) : 1)),
        toolCalls,
      },
      steps: {
        score: stepBudgetScore.score,
        steps,
        maxSteps: stepBudget,
        withinLimit: stepBudgetScore.withinBudget,
      },
      latency: {
        score: latencyBudgetScore.score,
        latencyMs,
        budgetMs: toFiniteNumber(options.latencyBudgetMs, 0),
        withinBudget: latencyBudgetScore.withinBudget,
      },
      tokens: {
        score: tokenBudgetScore.score,
        inputTokens,
        outputTokens,
        totalTokens,
        budget: toFiniteNumber(options.tokenBudget, 0),
        withinBudget: tokenBudgetScore.withinBudget,
      },
      cost: {
        score: costBudgetScore.score,
        costUsd,
        budgetUsd: toFiniteNumber(options.costBudgetUsd, 0),
        withinBudget: costBudgetScore.withinBudget,
      },
    },
  };
}

export function createDefaultScorer() {
  return { score: scoreEvalTaskResult };
}
