import type {
  AgentId,
  AgentResult,
  AgentTask,
  OrchestrationEvent,
  OrchestrationMode,
} from './types.js';
import type { AgentWorkflowStep } from './workflow-types.js';

export type CreateHandoffEventInput = {
  mode: OrchestrationMode;
  runId: string;
  step: AgentWorkflowStep;
  task: AgentTask;
  results: readonly AgentResult[];
  at: string;
};

function taskIdToStepId(taskId: string): string {
  return taskId.startsWith('task_') ? taskId.slice('task_'.length) : taskId;
}

function inferFromAgentId(step: AgentWorkflowStep, results: readonly AgentResult[]): AgentId | undefined {
  const dependencies = new Set(step.dependencies || []);
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result) continue;
    if (dependencies.size === 0) return result.agentId;
    if (dependencies.has(taskIdToStepId(result.taskId))) return result.agentId;
  }
  return undefined;
}

function defaultReason(step: AgentWorkflowStep): string {
  const dependencies = step.dependencies?.join(', ') || 'initial assignment';
  return `Controlled handoff for ${step.title} after ${dependencies}.`;
}

export function createHandoffEvent(input: CreateHandoffEventInput): OrchestrationEvent | null {
  if (input.mode !== 'handoff') return null;
  const fromAgentId = input.step.handoff?.fromAgentId ?? inferFromAgentId(input.step, input.results);
  const event = {
    type: 'handoff_started' as const,
    runId: input.runId,
    taskId: input.task.taskId,
    toAgentId: input.task.agentId,
    reason: input.step.handoff?.reason || defaultReason(input.step),
    contextRefIds: input.task.inputRefs.map((ref) => ref.refId),
    budget: { ...input.task.budget },
    at: input.at,
  };
  return fromAgentId ? { ...event, fromAgentId } : event;
}