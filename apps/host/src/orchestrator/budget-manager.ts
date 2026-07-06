import type { AgentBudget, AgentResult, AgentTask, AgentUsage, BudgetCounter, BudgetSnapshot } from './types.js';

export class BudgetExceededError extends Error {
  statusCode = 413;

  constructor(message: string, readonly snapshot: BudgetSnapshot) {
    super(message);
  }
}

export const DEFAULT_ORCHESTRATOR_BUDGET: BudgetCounter = {
  modelCalls: 8,
  toolCalls: 80,
  inputTokens: 80_000,
  outputTokens: 20_000,
  runtimeMs: 10 * 60_000,
  filesRead: 120,
  bytesRead: 4 * 1024 * 1024,
};

const ZERO_USAGE: AgentUsage = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  runtimeMs: 0,
  filesRead: 0,
  bytesRead: 0,
};

function fromTaskBudget(budget: AgentBudget): BudgetCounter {
  return {
    modelCalls: budget.maxModelCalls,
    toolCalls: budget.maxToolCalls,
    inputTokens: budget.maxInputTokens,
    outputTokens: budget.maxOutputTokens,
    runtimeMs: budget.maxRuntimeMs,
    filesRead: budget.maxFilesRead,
    bytesRead: budget.maxBytesRead,
  };
}

function add(left: BudgetCounter, right: BudgetCounter): BudgetCounter {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    toolCalls: left.toolCalls + right.toolCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    runtimeMs: left.runtimeMs + right.runtimeMs,
    filesRead: left.filesRead + right.filesRead,
    bytesRead: left.bytesRead + right.bytesRead,
  };
}

function subtract(left: BudgetCounter, right: BudgetCounter): BudgetCounter {
  return {
    modelCalls: left.modelCalls - right.modelCalls,
    toolCalls: left.toolCalls - right.toolCalls,
    inputTokens: left.inputTokens - right.inputTokens,
    outputTokens: left.outputTokens - right.outputTokens,
    runtimeMs: left.runtimeMs - right.runtimeMs,
    filesRead: left.filesRead - right.filesRead,
    bytesRead: left.bytesRead - right.bytesRead,
  };
}

function firstExceeded(limit: BudgetCounter, used: BudgetCounter): keyof BudgetCounter | null {
  const keys: Array<keyof BudgetCounter> = [
    'modelCalls',
    'toolCalls',
    'inputTokens',
    'outputTokens',
    'runtimeMs',
    'filesRead',
    'bytesRead',
  ];
  return keys.find((key) => used[key] > limit[key]) ?? null;
}

export class BudgetManager {
  private readonly limit: BudgetCounter;
  private used: BudgetCounter;

  constructor(limit: BudgetCounter = DEFAULT_ORCHESTRATOR_BUDGET) {
    this.limit = { ...limit };
    this.used = { ...ZERO_USAGE };
  }

  snapshot(): BudgetSnapshot {
    return {
      limit: { ...this.limit },
      used: { ...this.used },
      remaining: subtract(this.limit, this.used),
    };
  }

  assertCanStartTask(task: AgentTask): BudgetSnapshot {
    const projected = add(this.used, fromTaskBudget(task.budget));
    const exceeded = firstExceeded(this.limit, projected);
    if (exceeded) {
      throw new BudgetExceededError(`Orchestrator budget exceeded before task ${task.taskId}: ${exceeded}`, this.snapshot());
    }
    return this.snapshot();
  }

  recordResult(result: AgentResult): BudgetSnapshot {
    this.used = add(this.used, result.usage);
    const exceeded = firstExceeded(this.limit, this.used);
    const snapshot = this.snapshot();
    if (exceeded) {
      throw new BudgetExceededError(`Orchestrator budget exceeded after task ${result.taskId}: ${exceeded}`, snapshot);
    }
    return snapshot;
  }
}
