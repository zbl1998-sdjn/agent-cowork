import { runSubagent } from '../runtime/subagent.js';
import { LOCAL_IDENTITY_SCOPE } from '../security/identity-scope.js';
import type {
  AgentDefinition,
  AgentResult,
  AgentTask,
  AgentUsage,
  ContextPack,
  JsonObject,
} from './types.js';
import type {
  RunEventsLike,
  RunsIndexLike,
  SubagentStep,
  ToolRegistryLike,
} from '../runtime/subagent.js';

const SAFE_READ_ONLY_TOOLS = new Set(['SearchWorkspace', 'git.status', 'git.diff', 'git.log']);
const ZERO_USAGE: AgentUsage = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  runtimeMs: 0,
  filesRead: 0,
  bytesRead: 0,
};

type ToolDescriptorLike = {
  risk?: string;
  mutating?: boolean;
  requiresApproval?: boolean;
};

export type ReadOnlyToolRegistryLike = ToolRegistryLike & {
  descriptor?(name: string): ToolDescriptorLike | null;
};

export type SubagentTaskRunnerOptions = {
  registry: ReadOnlyToolRegistryLike;
  trustedRoot: string;
  runStoreRoot: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: RunsIndexLike | null;
  context?: Record<string, unknown>;
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function contextQuery(task: AgentTask, context: ContextPack): string {
  const labels = context.entries.map((entry) => `${entry.label}: ${entry.text || entry.uri}`).join('\n');
  return [
    context.userGoalSummary,
    task.title,
    task.instruction,
    labels,
  ].filter(Boolean).join('\n').slice(0, 1200);
}

function assertSafeReadOnlyTool(registry: ReadOnlyToolRegistryLike, tool: string): void {
  if (!SAFE_READ_ONLY_TOOLS.has(tool)) {
    throw new Error(`Subagent task runner refused unsupported tool: ${tool}`);
  }
  if (!registry.has(tool)) {
    throw new Error(`Subagent task runner missing tool: ${tool}`);
  }
  const descriptor = registry.descriptor?.(tool);
  if (descriptor && (descriptor.mutating === true || descriptor.requiresApproval === true || descriptor.risk === 'high')) {
    throw new Error(`Subagent task runner refused non-read-only tool: ${tool}`);
  }
}

function planSteps(task: AgentTask, context: ContextPack, agent: AgentDefinition, registry: ReadOnlyToolRegistryLike): SubagentStep[] {
  const steps: SubagentStep[] = [];
  const allowed = new Set(agent.allowedTools);
  if (allowed.has('SearchWorkspace') && registry.has('SearchWorkspace')) {
    steps.push({
      tool: 'SearchWorkspace',
      note: `Ground ${agent.displayName} output in local workspace evidence.`,
      args: {
        query: contextQuery(task, context),
        limit: Math.min(8, Math.max(1, task.budget.maxFilesRead || 5)),
        maxFiles: Math.min(40, Math.max(5, task.budget.maxFilesRead || 10)),
        maxFileBytes: Math.min(128 * 1024, Math.max(16 * 1024, task.budget.maxBytesRead || 64 * 1024)),
      },
    });
  }
  for (const step of steps) {
    assertSafeReadOnlyTool(registry, String(step.tool || ''));
  }
  return steps.slice(0, Math.max(1, Math.min(task.budget.maxToolCalls, 3)));
}

function noToolResult(task: AgentTask, context: ContextPack, agent: AgentDefinition): AgentResult {
  const summary = `${agent.displayName} completed ${task.title} without a permitted read-only tool.`;
  return {
    taskId: task.taskId,
    agentId: task.agentId,
    status: 'succeeded',
    summary,
    structured: {
      summary,
      runner: 'subagent-adapter',
      toolCalls: 0,
      sourceCount: context.entries.length,
    },
    evidenceRefs: context.entries.map((entry) => ({ refId: entry.refId, label: entry.label, uri: entry.uri })),
    artifactRefs: [],
    proposedOps: [],
    confidence: 0.62,
    warnings: ['No safe read-only tool was permitted for this agent; result is based on packed context only.'],
    usage: { ...ZERO_USAGE, inputTokens: estimateTokens(contextQuery(task, context)) },
    nextSuggestedTasks: [],
  };
}

function resultSummary(steps: readonly unknown[]): string {
  return steps
    .map((step) => {
      const row = step as { tool?: unknown; status?: unknown; summary?: unknown; error?: unknown };
      const status = row.status ? String(row.status) : 'unknown';
      const tool = row.tool ? String(row.tool) : 'tool';
      const detail = row.error ? String(row.error) : JSON.stringify(row.summary || {}).slice(0, 240);
      return `${tool}:${status} ${detail}`;
    })
    .join(' | ')
    .slice(0, 900);
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}

export function createSubagentTaskRunner(options: SubagentTaskRunnerOptions) {
  const {
  registry,
  trustedRoot,
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  context: suppliedContext,
  } = options;
  const context = Object.hasOwn(options, 'context')
    ? (suppliedContext ?? {})
    : LOCAL_IDENTITY_SCOPE;
  return async function subagentTaskRunner(
    task: AgentTask,
    pack: ContextPack,
    agent: AgentDefinition,
  ): Promise<AgentResult> {
    const startedAt = Date.now();
    const steps = planSteps(task, pack, agent, registry);
    if (steps.length === 0) {
      return noToolResult(task, pack, agent);
    }
    const out = await runSubagent({
      goal: `${agent.displayName}: ${task.title}\n${task.instruction}`,
      steps,
      registry,
      trustedRoot,
      runStoreRoot,
      runEvents,
      runsIndex,
      context: {
        ...context,
        parentOrchestratorRunId: task.runId,
        parentOrchestratorTaskId: task.taskId,
        agentId: task.agentId,
      },
      stopOnError: false,
      contextBudgetBytes: 48 * 1024,
      maxSteps: Math.max(1, Math.min(task.budget.maxToolCalls, 3)),
    });
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const summary = `${agent.displayName} completed ${task.title} via subagent run ${out.runId}. ${resultSummary(out.steps)}`;
    const warnings = [
      ...(out.ok ? [] : ['One or more subagent tool steps failed; review child run evidence.']),
      ...(pack.redactionReport.redactedCount > 0 ? ['Input contained redacted secret-like text.'] : []),
      ...(pack.forbidden.length > 0 ? [`${pack.forbidden.length} context refs omitted by policy.`] : []),
    ];
    const inputChars = pack.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    return {
      taskId: task.taskId,
      agentId: task.agentId,
      status: out.ok ? 'succeeded' : 'partial',
      summary,
      structured: {
        summary,
        runner: 'subagent-adapter',
        subagentRunId: out.runId,
        subagentStatus: out.ok ? 'succeeded' : 'partial',
        toolSteps: out.steps.map((step) => jsonObject(step)),
        sourceCount: pack.entries.length,
        redactedCount: pack.redactionReport.redactedCount,
      },
      evidenceRefs: pack.entries.map((entry) => ({ refId: entry.refId, label: entry.label, uri: entry.uri })),
      artifactRefs: [`subagent-run:${out.runId}`],
      proposedOps: [],
      confidence: out.ok ? 0.78 : 0.58,
      warnings,
      usage: {
        ...ZERO_USAGE,
        toolCalls: out.steps.length,
        inputTokens: estimateTokens(inputChars ? contextQuery(task, pack) : task.instruction),
        outputTokens: estimateTokens(summary),
        runtimeMs: elapsedMs,
        filesRead: pack.entries.filter((entry) => entry.kind === 'file').length,
        bytesRead: inputChars,
      },
      nextSuggestedTasks: [],
    };
  };
}
