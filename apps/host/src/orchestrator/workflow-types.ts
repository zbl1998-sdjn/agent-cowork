import type {
  AgentBudget,
  AgentDefinition,
  AgentId,
  AgentResult,
  AgentTask,
  ContextPack,
  ContextRef,
  OrchestrationCheckpoint,
  OrchestrationMode,
  SecurityMode,
} from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import type { BudgetManager } from './budget-manager.js';
import type { ContextPacker } from './context-packer.js';
import type { GuardrailEngine } from './guardrail-engine.js';
import type { TraceRecorder } from './trace-recorder.js';
import type { FileSummaryCache } from './file-summary-cache.js';

export type AgentWorkflowStep = {
  id: string;
  kind: 'agent_task';
  agentId: AgentId;
  title: string;
  instruction: string;
  expectedOutput: string;
  inputRefs?: string[];
  dependencies?: string[];
  timeoutMs?: number;
  budget?: AgentBudget;
  approvalPolicy?: AgentTask['approvalPolicy'];
  handoff?: {
    fromAgentId?: AgentId;
    reason?: string;
  };
};

export type SynthesisWorkflowStep = {
  id: string;
  kind: 'synthesis';
  dependencies?: string[];
};

export type VerificationWorkflowStep = {
  id: string;
  kind: 'verification';
  dependencies?: string[];
  minimumConfidence?: number;
};

export type WorkflowStep = AgentWorkflowStep | SynthesisWorkflowStep | VerificationWorkflowStep;

export type OrchestrationRecipe = {
  id: string;
  displayName: string;
  mode: OrchestrationMode;
  agents: AgentId[];
  steps: WorkflowStep[];
};

export type WorkflowRunInput = {
  runId?: string;
  userGoal: string;
  workspaceRoot: string;
  securityMode: SecurityMode;
  refs?: readonly ContextRef[];
  resumeCheckpoint?: OrchestrationCheckpoint;
  signal?: AbortSignal | null;
};

export type WorkflowRunnerControls = { signal?: AbortSignal | null | undefined };

export type AgentTaskRunner = (
  task: AgentTask,
  context: ContextPack,
  agent: AgentDefinition,
  controls?: WorkflowRunnerControls,
) => Promise<AgentResult>;

export type OrchestrationCheckpointStoreLike = {
  save(checkpoint: OrchestrationCheckpoint): string;
};

export type WorkflowRunnerOptions = {
  registry: AgentRegistry;
  taskRunner: AgentTaskRunner;
  contextPacker?: ContextPacker;
  budgetManager?: BudgetManager;
  guardrails?: GuardrailEngine;
  trace?: TraceRecorder;
  checkpointStore?: OrchestrationCheckpointStoreLike;
  fileSummaryCache?: FileSummaryCache;
  now?: () => Date;
};
