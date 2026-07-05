import type { AgentResult, AgentTask, ContextRef, OrchestrationStatus } from './types.js';
import type { AgentWorkflowStep, OrchestrationRecipe, WorkflowStep } from './workflow-types.js';

const ALLOWED_TRANSITIONS: Record<OrchestrationStatus, OrchestrationStatus[]> = {
  created: ['planning', 'cancelled', 'failed'],
  planning: ['running', 'cancelled', 'failed'],
  running: ['synthesizing', 'verifying', 'waiting_approval', 'completed', 'cancelled', 'failed'],
  synthesizing: ['running', 'verifying', 'completed', 'cancelled', 'failed'],
  verifying: ['running', 'completed', 'cancelled', 'failed'],
  waiting_approval: ['running', 'completed', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transitionRunStatus(current: OrchestrationStatus, next: OrchestrationStatus): OrchestrationStatus {
  if (current === next) {
    return next;
  }
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid orchestrator transition: ${current} -> ${next}`);
  }
  return next;
}

export function sanitizeStepId(id: string): string {
  return id.trim().replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) || 'step';
}

export function dependenciesOf(step: WorkflowStep): string[] {
  return step.dependencies ? [...step.dependencies] : [];
}

export function validateRecipe(recipe: OrchestrationRecipe): void {
  if (!recipe.id.trim()) {
    throw new Error('OrchestrationRecipe.id is required');
  }
  if (recipe.steps.length === 0) {
    throw new Error('OrchestrationRecipe.steps must not be empty');
  }
  const ids = new Set<string>();
  for (const step of recipe.steps) {
    if (!step.id.trim()) {
      throw new Error('WorkflowStep.id is required');
    }
    if (ids.has(step.id)) {
      throw new Error(`Duplicate workflow step: ${step.id}`);
    }
    ids.add(step.id);
  }
  for (const step of recipe.steps) {
    for (const dependency of dependenciesOf(step)) {
      if (!ids.has(dependency)) {
        throw new Error(`Workflow step ${step.id} depends on unknown step ${dependency}`);
      }
    }
  }
}

export function resultIsComplete(result: AgentResult, task: AgentTask): boolean {
  return result.taskId === task.taskId
    && result.agentId === task.agentId
    && typeof result.summary === 'string'
    && result.structured != null
    && typeof result.structured === 'object'
    && !Array.isArray(result.structured)
    && Number.isFinite(result.confidence);
}

export function selectRefs(step: AgentWorkflowStep, refs: readonly ContextRef[]): ContextRef[] {
  if (!step.inputRefs || step.inputRefs.length === 0) {
    return refs.map((ref) => ({ ...ref, dataTags: [...ref.dataTags], metadata: { ...ref.metadata } }));
  }
  const allowed = new Set(step.inputRefs);
  return refs
    .filter((ref) => allowed.has(ref.refId))
    .map((ref) => ({ ...ref, dataTags: [...ref.dataTags], metadata: { ...ref.metadata } }));
}

export function createFailedSystemResult(runId: string, message: string): AgentResult {
  return {
    taskId: `task_system_${sanitizeStepId(runId)}`,
    agentId: 'supervisor',
    status: 'failed',
    summary: message,
    structured: { error: message },
    evidenceRefs: [],
    artifactRefs: [],
    proposedOps: [],
    confidence: 0,
    warnings: [message],
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      runtimeMs: 0,
      filesRead: 0,
      bytesRead: 0,
    },
    nextSuggestedTasks: [],
  };
}
