export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AgentId =
  | 'supervisor'
  | 'router'
  | 'researcher'
  | 'writer'
  | 'excel_helper'
  | 'ppt_designer'
  | 'word_polisher'
  | 'file_organizer'
  | 'verifier'
  | 'security_reviewer'
  | 'fallback_agent';

export type AgentModelProfile = 'none' | 'cheap' | 'balanced' | 'strong' | 'local';
export type AgentRiskLevel = 'low' | 'medium' | 'high';
export type AgentDataTag = 'public' | 'internal' | 'confidential' | 'secret';
export type RedactionMode = 'none' | 'secrets_only' | 'strict';
export type ApprovalPolicy = 'never' | 'before_write' | 'before_network' | 'always';

export type AgentBudget = {
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRuntimeMs: number;
  maxFilesRead: number;
  maxBytesRead: number;
};

export type AgentContextPolicy = {
  maxInputChars: number;
  canSeeRawFiles: boolean;
  canSeeFileNames: boolean;
  canSeePriorMemory: boolean;
  canSeeOtherAgentScratchpad: boolean;
  allowedDataTags: AgentDataTag[];
  redactionMode: RedactionMode;
};

export type AgentOutputFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export type AgentOutputSchema = {
  name: string;
  version: number;
  fields: Record<string, AgentOutputFieldType>;
  required: string[];
};

export type AgentDefinition = {
  id: AgentId;
  displayName: string;
  description: string;
  rolePrompt: string;
  defaultModelProfile: AgentModelProfile;
  allowedTools: string[];
  deniedTools: string[];
  contextPolicy: AgentContextPolicy;
  outputSchema: AgentOutputSchema;
  budget: AgentBudget;
  riskLevel: AgentRiskLevel;
  canWrite: boolean;
  canCallNetwork: boolean;
  requiresApprovalBeforeRun: boolean;
};

export type ContextRef = {
  refId: string;
  kind: 'user_goal' | 'file' | 'artifact' | 'memory' | 'summary';
  label: string;
  dataTags: AgentDataTag[];
  text: string;
  summary: string;
  uri: string;
  metadata: JsonObject;
};

export type ContextPackEntry = {
  refId: string;
  kind: ContextRef['kind'];
  label: string;
  dataTags: AgentDataTag[];
  text: string;
  truncated: boolean;
  uri: string;
  metadata: JsonObject;
};

export type RedactionReport = {
  mode: RedactionMode;
  redactedCount: number;
  omittedRefs: number;
  truncatedRefs: number;
};

export type ContextPack = {
  contextPackId: string;
  agentId: AgentId;
  taskId: string;
  userGoalSummary: string;
  entries: ContextPackEntry[];
  forbidden: string[];
  redactionReport: RedactionReport;
};

export type EvidenceRef = {
  refId: string;
  label: string;
  uri: string;
};

export type FileOpPreview = {
  kind: 'create' | 'update' | 'move' | 'delete';
  path: string;
  reason: string;
};

export type AgentUsage = {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  runtimeMs: number;
  filesRead: number;
  bytesRead: number;
};

export type AgentTask = {
  taskId: string;
  runId: string;
  parentTaskId: string;
  agentId: AgentId;
  title: string;
  instruction: string;
  inputRefs: ContextRef[];
  expectedOutput: string;
  outputSchemaName: string;
  priority: 'low' | 'normal' | 'high';
  dependencies: string[];
  timeoutMs: number;
  budget: AgentBudget;
  approvalPolicy: ApprovalPolicy;
};

export type AgentResultStatus = 'succeeded' | 'failed' | 'partial' | 'skipped';

export type AgentResult = {
  taskId: string;
  agentId: AgentId;
  status: AgentResultStatus;
  summary: string;
  structured: JsonObject;
  evidenceRefs: EvidenceRef[];
  artifactRefs: string[];
  proposedOps: FileOpPreview[];
  confidence: number;
  warnings: string[];
  usage: AgentUsage;
  nextSuggestedTasks: AgentTask[];
};

export type BudgetCounter = AgentUsage;

export type BudgetSnapshot = {
  limit: BudgetCounter;
  used: BudgetCounter;
  remaining: BudgetCounter;
};

export type OrchestrationMode = 'workflow' | 'supervisor' | 'router' | 'map_reduce' | 'handoff';
export type OrchestrationStatus =
  | 'created'
  | 'planning'
  | 'running'
  | 'synthesizing'
  | 'verifying'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type SecurityMode = 'local_strict' | 'enterprise_hybrid' | 'cloud_opt_in';

export type OrchestrationEvent =
  | { type: 'run_started'; runId: string; goal: string; at: string }
  | { type: 'recipe_selected'; runId: string; recipeId: string; reason: string; at: string }
  | { type: 'handoff_started'; runId: string; taskId: string; fromAgentId?: AgentId; toAgentId: AgentId; reason: string; contextRefIds: string[]; budget: AgentBudget; at: string }
  | { type: 'agent_task_started'; runId: string; taskId: string; agentId: AgentId; title: string; at: string }
  | { type: 'summary_cache_updated'; runId: string; taskId: string; agentId: AgentId; hits: number; misses: number; stores: number; cacheKeys: string[]; at: string }
  | { type: 'agent_task_completed'; runId: string; taskId: string; agentId: AgentId; status: AgentResultStatus; summary: string; at: string }
  | { type: 'agent_task_failed'; runId: string; taskId: string; agentId: AgentId; error: string; fallbackUsed: boolean; at: string }
  | { type: 'synthesis_started'; runId: string; at: string }
  | { type: 'verification_completed'; runId: string; passed: boolean; warnings: string[]; at: string }
  | { type: 'budget_updated'; runId: string; budget: BudgetSnapshot; at: string }
  | { type: 'run_completed'; runId: string; status: OrchestrationStatus; at: string };

export type OrchestrationRun = {
  runId: string;
  userGoal: string;
  recipeId: string;
  mode: OrchestrationMode;
  status: OrchestrationStatus;
  workspaceRoot: string;
  securityMode: SecurityMode;
  agents: AgentId[];
  tasks: AgentTask[];
  results: AgentResult[];
  eventsPath: string;
  checkpointPath: string;
  auditPath: string;
  artifacts: string[];
  startedAt: string;
  updatedAt: string;
};

export type OrchestrationCheckpoint = {
  version: 1;
  runId: string;
  userGoal: string;
  recipeId: string;
  mode: OrchestrationMode;
  status: OrchestrationStatus;
  workspaceRoot: string;
  securityMode: SecurityMode;
  agents: AgentId[];
  refs: ContextRef[];
  tasks: AgentTask[];
  results: AgentResult[];
  completedStepIds: string[];
  currentStepId: string;
  eventsPath: string;
  checkpointPath: string;
  artifacts: string[];
  startedAt: string;
  updatedAt: string;
};
