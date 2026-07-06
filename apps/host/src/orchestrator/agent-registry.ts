import type {
  AgentBudget,
  AgentContextPolicy,
  AgentDefinition,
  AgentId,
  AgentOutputSchema,
} from './types.js';

export class AgentRegistryError extends Error {
  statusCode = 400;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxModelCalls: 1,
  maxToolCalls: 10,
  maxInputTokens: 16_000,
  maxOutputTokens: 4_000,
  maxRuntimeMs: 60_000,
  maxFilesRead: 20,
  maxBytesRead: 512 * 1024,
};

const READ_ONLY_CONTEXT: AgentContextPolicy = {
  maxInputChars: 24_000,
  canSeeRawFiles: true,
  canSeeFileNames: true,
  canSeePriorMemory: false,
  canSeeOtherAgentScratchpad: false,
  allowedDataTags: ['public', 'internal', 'confidential'],
  redactionMode: 'secrets_only',
};

const SUMMARY_ONLY_CONTEXT: AgentContextPolicy = {
  maxInputChars: 12_000,
  canSeeRawFiles: false,
  canSeeFileNames: true,
  canSeePriorMemory: false,
  canSeeOtherAgentScratchpad: false,
  allowedDataTags: ['public', 'internal', 'confidential'],
  redactionMode: 'secrets_only',
};

const SECURITY_CONTEXT: AgentContextPolicy = {
  maxInputChars: 16_000,
  canSeeRawFiles: false,
  canSeeFileNames: true,
  canSeePriorMemory: false,
  canSeeOtherAgentScratchpad: false,
  allowedDataTags: ['public', 'internal', 'confidential', 'secret'],
  redactionMode: 'strict',
};

const SUMMARY_SCHEMA: AgentOutputSchema = {
  name: 'summary',
  version: 1,
  fields: { summary: 'string', warnings: 'array', evidenceRefs: 'array' },
  required: ['summary'],
};

const REVIEW_SCHEMA: AgentOutputSchema = {
  name: 'review',
  version: 1,
  fields: { passed: 'boolean', warnings: 'array', summary: 'string' },
  required: ['passed', 'summary'],
};

function cloneDefinition(agent: AgentDefinition): AgentDefinition {
  return JSON.parse(JSON.stringify(agent)) as AgentDefinition;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new AgentRegistryError(`AgentDefinition.${label} is required`);
  }
}

function validateAgentDefinition(agent: AgentDefinition): void {
  assertNonEmpty(agent.id, 'id');
  assertNonEmpty(agent.displayName, 'displayName');
  assertNonEmpty(agent.rolePrompt, 'rolePrompt');
  assertNonEmpty(agent.outputSchema.name, 'outputSchema.name');
  if (agent.outputSchema.version < 1) {
    throw new AgentRegistryError('AgentDefinition.outputSchema.version must be >= 1');
  }
  if (agent.contextPolicy.maxInputChars < 1) {
    throw new AgentRegistryError('AgentDefinition.contextPolicy.maxInputChars must be positive');
  }
  if (agent.budget.maxRuntimeMs < 1) {
    throw new AgentRegistryError('AgentDefinition.budget.maxRuntimeMs must be positive');
  }
  const denied = new Set(agent.deniedTools);
  for (const tool of agent.allowedTools) {
    if (denied.has(tool)) {
      throw new AgentRegistryError(`AgentDefinition.${agent.id} allows and denies ${tool}`);
    }
  }
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, AgentDefinition>();

  register(agent: AgentDefinition): this {
    validateAgentDefinition(agent);
    if (this.agents.has(agent.id)) {
      throw new AgentRegistryError(`Agent already registered: ${agent.id}`);
    }
    this.agents.set(agent.id, cloneDefinition(agent));
    return this;
  }

  registerMany(agents: readonly AgentDefinition[]): this {
    for (const agent of agents) {
      this.register(agent);
    }
    return this;
  }

  get(agentId: AgentId): AgentDefinition {
    const agent = this.agents.get(agentId);
    if (!agent) {
      const err = new AgentRegistryError(`Unknown agent: ${agentId}`);
      err.statusCode = 404;
      throw err;
    }
    return cloneDefinition(agent);
  }

  has(agentId: AgentId): boolean {
    return this.agents.has(agentId);
  }

  list(): AgentDefinition[] {
    return Array.from(this.agents.values()).map(cloneDefinition);
  }
}

export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: 'supervisor',
    displayName: 'Supervisor',
    description: 'Selects workflow tasks and merges specialist outputs.',
    rolePrompt: 'Coordinate the task, keep scope tight, and request approval before writes.',
    defaultModelProfile: 'balanced',
    allowedTools: ['orchestrator.run_agent', 'orchestrator.synthesize'],
    deniedTools: ['sandbox.exec'],
    contextPolicy: SUMMARY_ONLY_CONTEXT,
    outputSchema: SUMMARY_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxModelCalls: 2, maxRuntimeMs: 90_000 },
    riskLevel: 'medium',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'researcher',
    displayName: 'Researcher',
    description: 'Reads bounded source context and extracts evidence.',
    rolePrompt: 'Extract grounded findings with evidence references only from the supplied context.',
    defaultModelProfile: 'cheap',
    allowedTools: ['Read', 'Glob', 'Grep', 'SearchWorkspace'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec'],
    contextPolicy: READ_ONLY_CONTEXT,
    outputSchema: SUMMARY_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxToolCalls: 20, maxFilesRead: 30 },
    riskLevel: 'low',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'writer',
    displayName: 'Writer',
    description: 'Turns summaries into a user-facing draft.',
    rolePrompt: 'Write a concise draft from summaries and mark low-confidence claims.',
    defaultModelProfile: 'balanced',
    allowedTools: ['ArtifactDraft', 'SearchWorkspace'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec', 'WebFetch'],
    contextPolicy: SUMMARY_ONLY_CONTEXT,
    outputSchema: SUMMARY_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxToolCalls: 5 },
    riskLevel: 'medium',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'verifier',
    displayName: 'Verifier',
    description: 'Checks whether output satisfies the requested workflow.',
    rolePrompt: 'Check completeness, missing evidence, contradictions, and obvious placeholders.',
    defaultModelProfile: 'cheap',
    allowedTools: ['Read', 'CompareChecklist', 'SearchWorkspace'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec'],
    contextPolicy: SUMMARY_ONLY_CONTEXT,
    outputSchema: REVIEW_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxToolCalls: 10, maxRuntimeMs: 45_000 },
    riskLevel: 'low',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'security_reviewer',
    displayName: 'Security reviewer',
    description: 'Checks policy, data tags, write previews, and network risk.',
    rolePrompt: 'Block risky writes, secret exposure, and external calls that lack approval.',
    defaultModelProfile: 'none',
    allowedTools: ['PolicyDecision', 'AuditReader', 'EgressPreview', 'SearchWorkspace'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec', 'WebFetch'],
    contextPolicy: SECURITY_CONTEXT,
    outputSchema: REVIEW_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxModelCalls: 0, maxToolCalls: 10, maxRuntimeMs: 20_000 },
    riskLevel: 'low',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'excel_helper',
    displayName: 'Excel helper',
    description: 'Profiles spreadsheet-like inputs and data-quality clues.',
    rolePrompt: 'Summarize tabular inputs, missing fields, and chartable metrics without writing files.',
    defaultModelProfile: 'cheap',
    allowedTools: ['SearchWorkspace', 'data.profile', 'data.analyze'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec', 'data.createChartArtifact'],
    contextPolicy: READ_ONLY_CONTEXT,
    outputSchema: SUMMARY_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxToolCalls: 8, maxFilesRead: 20 },
    riskLevel: 'low',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'ppt_designer',
    displayName: 'PPT designer',
    description: 'Creates presentation outlines from grounded summaries.',
    rolePrompt: 'Turn source context into slide-level structure and visual suggestions without writing files.',
    defaultModelProfile: 'balanced',
    allowedTools: ['SearchWorkspace'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec'],
    contextPolicy: SUMMARY_ONLY_CONTEXT,
    outputSchema: SUMMARY_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxToolCalls: 5 },
    riskLevel: 'medium',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'word_polisher',
    displayName: 'Word polisher',
    description: 'Polishes document briefs and wording from supplied context.',
    rolePrompt: 'Improve structure, wording, and tone from source context while preserving evidence boundaries.',
    defaultModelProfile: 'balanced',
    allowedTools: ['SearchWorkspace'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec'],
    contextPolicy: SUMMARY_ONLY_CONTEXT,
    outputSchema: SUMMARY_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxToolCalls: 5 },
    riskLevel: 'medium',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },
  {
    id: 'file_organizer',
    displayName: 'File organizer',
    description: 'Plans non-mutating file organization previews.',
    rolePrompt: 'Suggest reversible file organization plans and do not perform writes.',
    defaultModelProfile: 'cheap',
    allowedTools: ['SearchWorkspace', 'file.plan-organize'],
    deniedTools: ['Write', 'Edit', 'sandbox.exec', 'GitCommit'],
    contextPolicy: READ_ONLY_CONTEXT,
    outputSchema: SUMMARY_SCHEMA,
    budget: { ...DEFAULT_AGENT_BUDGET, maxToolCalls: 8, maxFilesRead: 30 },
    riskLevel: 'low',
    canWrite: false,
    canCallNetwork: false,
    requiresApprovalBeforeRun: false,
  },];

export function createDefaultAgentRegistry(): AgentRegistry {
  return new AgentRegistry().registerMany(BUILT_IN_AGENTS);
}
