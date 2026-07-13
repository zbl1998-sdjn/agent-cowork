import path from 'node:path';
import { z } from 'zod';
import {
  createDefaultAgentRegistry,
  createOrchestrationCheckpointStore,
  createProviderTaskRunner,
  TraceRecorder,
  WorkflowRunner,
} from '../orchestrator/index.js';
import { getOrchestrationRecipeDefinition, ORCHESTRATION_RECIPE_IDS } from '../orchestrator/recipe-registry.js';
import { createSubagentTaskRunner } from '../orchestrator/subagent-task-runner.js';
import { defaultFileSummaryCacheFor } from './orchestrator-summary-cache.js';
import { createRunId, getRunPath, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { decodePathSegment } from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import { orchestratorOwner } from './orchestrator-owner-guard.js';
import { resolveOrchestratorSecurityMode } from './orchestrator-security-mode.js';
import type {
  AgentDefinition,
  AgentResult,
  AgentTask,
  AgentUsage,
  FileSummaryCache,
  ContextPack,
  ContextRef,
  JsonObject,
  OrchestrationEvent,
  OrchestrationRun,
  OrchestrationStatus,
} from '../orchestrator/index.js';
import type { OrchestrationRunnerKind } from '../orchestrator/recipe-registry.js';
import type { ReadOnlyToolRegistryLike } from '../orchestrator/subagent-task-runner.js';
import type { RunEventsLike as SubagentRunEventsLike, RunsIndexLike as SubagentRunsIndexLike } from '../runtime/subagent.js';
import type { RunRecord } from '../runtime/run-store.js';
import type { RunOwner } from '../util/run-owner.js';
import type { ModelConfig, ProviderChatArgs, ProviderChatResult } from '../engine/provider/index.js';
import type { AgentTaskRunner } from '../orchestrator/index.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

export type OrchestratorRequestContext = {
  tenantId?: string;
  userId?: string;
  traceId?: string;
  idempotencyKey?: string;
  securityMode?: string;
  [key: string]: unknown;
};
export type RunsIndexLike = { upsert?(record: unknown, context?: { traceId?: unknown } | Record<string, unknown>): unknown };
export type OrchestratorCancellationLike = {
  register?(runId: string, context?: RunOwner): AbortController;
  cancel?(runId: string, reason?: string, context?: RunOwner): boolean;
  done?(runId: string, context?: RunOwner): boolean;
};
export type ProviderModelCall = (args: ProviderChatArgs) => Promise<ProviderChatResult>;
export type RunOrchestrationOptions = {
  requestContext: OrchestratorRequestContext;
  runStoreRoot: string;
  runsIndex?: RunsIndexLike | null;
  runEvents?: SubagentRunEventsLike | null;
  toolRegistry?: ReadOnlyToolRegistryLike | null;
  modelConfig?: ModelConfig | null;
  modelCall?: ProviderModelCall | undefined;
  fetchImpl?: unknown;
  runId?: string;
  signal?: AbortSignal | null;
  cancellation?: OrchestratorCancellationLike | null;
  fileSummaryCache?: FileSummaryCache | null;
  safeTrustedRoot(input?: unknown): string;
};
export type RunWeeklyReportOptions = RunOrchestrationOptions;

const TERMINAL_ORCHESTRATOR_STATUSES = new Set<OrchestrationStatus>(['completed', 'cancelled', 'failed']);

const dataTagSchema = z.enum(['public', 'internal', 'confidential', 'secret']);
export const contextRefSchema = z.strictObject({
  refId: z.string().trim().min(1).max(160),
  kind: z.enum(['user_goal', 'file', 'artifact', 'memory', 'summary']).default('summary'),
  label: z.string().trim().min(1).max(500),
  dataTags: z.array(dataTagSchema).min(1).max(4).default(['internal']),
  text: z.string().max(100_000).default(''),
  summary: z.string().max(20_000).default(''),
  uri: z.string().max(1000).default(''),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const startOrchestrationSchema = z.strictObject({
  workspaceRoot: z.string().trim().min(1).max(1000).optional(),
  userGoal: z.string().trim().min(1).max(4000),
  recipeId: z.enum(ORCHESTRATION_RECIPE_IDS).default('weekly-report'),
  refs: z.array(contextRefSchema).max(80).default([]),
});
export type StartOrchestrationInput = z.infer<typeof startOrchestrationSchema>;

const ZERO_USAGE: AgentUsage = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  runtimeMs: 0,
  filesRead: 0,
  bytesRead: 0,
};

type HttpError = Error & { statusCode?: number; payload?: Record<string, unknown> };

function httpError(statusCode: number, message: string, payload: Record<string, unknown> = {}): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.payload = payload;
  return error;
}

function jsonObjectFrom(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function routeContext(requestContext: OrchestratorRequestContext): OrchestratorRequestContext {
  const owner = orchestratorOwner(requestContext);
  return omitUndefined({
    tenantId: owner.tenantId,
    userId: owner.userId,
    traceId: requestContext.traceId,
    securityMode: requestContext.securityMode,
  });
}

export function contextRefFromInput(input: z.infer<typeof contextRefSchema>): ContextRef {
  const text = input.text || input.summary || input.label;
  const summary = input.summary || input.text.slice(0, 800) || input.label;
  return {
    refId: input.refId,
    kind: input.kind,
    label: input.label,
    dataTags: [...input.dataTags],
    text,
    summary,
    uri: input.uri,
    metadata: jsonObjectFrom(input.metadata),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function deterministicP0TaskRunner(
  task: AgentTask,
  context: ContextPack,
  agent: AgentDefinition,
): Promise<AgentResult> {
  const joined = context.entries.map((entry) => entry.text).join('\n').trim();
  const sourceLabels = context.entries.map((entry) => entry.label).filter(Boolean);
  const warnings = [
    ...(context.redactionReport.redactedCount > 0 ? ['Input contained redacted secret-like text'] : []),
    ...(context.forbidden.length > 0 ? [`${context.forbidden.length} context refs omitted by policy`] : []),
  ];
  const summary = [
    `${agent.displayName} completed ${task.title}.`,
    joined ? `Context: ${joined.slice(0, 500)}` : 'No source context was supplied.',
  ].join(' ');
  const inputChars = context.entries.reduce((sum, entry) => sum + entry.text.length, 0);
  return {
    taskId: task.taskId,
    agentId: task.agentId,
    status: 'succeeded',
    summary,
    structured: {
      summary,
      sourceCount: context.entries.length,
      sources: sourceLabels,
      redactedCount: context.redactionReport.redactedCount,
      outputSchema: agent.outputSchema.name,
    },
    evidenceRefs: context.entries.map((entry) => ({ refId: entry.refId, label: entry.label, uri: entry.uri })),
    artifactRefs: task.agentId === 'writer' ? ['draft:weekly-report'] : [],
    proposedOps: [],
    confidence: warnings.length > 0 ? 0.82 : 0.92,
    warnings,
    usage: {
      ...ZERO_USAGE,
      modelCalls: agent.defaultModelProfile === 'none' ? 0 : 1,
      inputTokens: estimateTokens(inputChars ? joined : task.instruction),
      outputTokens: estimateTokens(summary),
      runtimeMs: 1,
      filesRead: context.entries.filter((entry) => entry.kind === 'file').length,
      bytesRead: inputChars,
    },
    nextSuggestedTasks: [],
  };
}

export function parseOrchestratorRunId(pathname: string, prefix: string, suffix = ''): string | null {
  const encoded = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  const runId = decodePathSegment(encoded);
  return runId && RUN_ID_RE.test(runId) ? runId : null;
}

export function orchestratorDetailPayload(record: RunRecord, context: OrchestratorRequestContext): Record<string, unknown> {
  const run = record.orchestratorRun as OrchestrationRun | undefined;
  const timeline = Array.isArray(record.events) ? record.events as OrchestrationEvent[] : [];
  return {
    context: routeContext(context),
    run: run || record,
    timeline,
    tasks: run?.tasks || [],
    results: run?.results || [],
    artifacts: run?.artifacts || [],
  };
}

export function indexRun(runsIndex: RunsIndexLike | null | undefined, record: RunRecord, context: OrchestratorRequestContext): void {
  if (typeof runsIndex?.upsert !== 'function') return;
  runsIndex.upsert(summariseRunForIndex(record, context), omitUndefined({ traceId: context.traceId }));
}

function subagentRunsIndex(runsIndex: RunsIndexLike | null | undefined): SubagentRunsIndexLike | null {
  if (typeof runsIndex?.upsert !== 'function') return null;
  return { upsert: (record, context = {}) => runsIndex.upsert?.(record, context) };
}

function hasUsableProviderConfig(modelConfig: ModelConfig | null | undefined): modelConfig is ModelConfig {
  if (!modelConfig) return false;
  const provider = modelConfig.provider;
  if (provider && typeof provider === 'object' && typeof (provider as { chatCompletion?: unknown }).chatCompletion === 'function') {
    return true;
  }
  return modelConfig.configured === true || typeof modelConfig.apiKey === 'string' && modelConfig.apiKey.trim().length > 0;
}

export function providerName(kind: OrchestrationRunnerKind): string {
  if (kind === 'subagent') return 'subagent-tool-loop';
  if (kind === 'provider') return 'model-provider-adapter';
  return 'deterministic-p0';
}

export function selectTaskRunner(kind: OrchestrationRunnerKind, options: RunOrchestrationOptions, workspaceRoot: string): {
  runnerKind: OrchestrationRunnerKind;
  taskRunner: AgentTaskRunner;
} {
  if (kind === 'deterministic') {
    if (hasUsableProviderConfig(options.modelConfig)) {
      const providerOptions = {
        modelConfig: options.modelConfig,
        ...(options.modelCall ? { modelCall: options.modelCall } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        trustedRoot: workspaceRoot,
      };
      return {
        runnerKind: 'provider',
        taskRunner: createProviderTaskRunner(providerOptions),
      };
    }
    return { runnerKind: 'deterministic', taskRunner: deterministicP0TaskRunner };
  }
  if (!options.toolRegistry) {
    throw httpError(503, 'Orchestrator subagent runner requires ToolRegistry injection', { runnerKind: kind });
  }
  return {
    runnerKind: 'subagent',
    taskRunner: createSubagentTaskRunner({
      registry: options.toolRegistry,
      trustedRoot: workspaceRoot,
      runStoreRoot: options.runStoreRoot,
      runEvents: options.runEvents || null,
      runsIndex: subagentRunsIndex(options.runsIndex),
      context: routeContext(options.requestContext),
    }),
  };
}

export async function runOrchestration(
  input: StartOrchestrationInput,
  options: RunOrchestrationOptions,
): Promise<{ record: RunRecord; runPath: string; events: OrchestrationEvent[]; runnerKind: OrchestrationRunnerKind }> {
  const definition = getOrchestrationRecipeDefinition(input.recipeId);
  const runId = options.runId || createRunId();
  const tracePath = path.join(options.runStoreRoot, `${runId}.events.jsonl`);
  const trace = new TraceRecorder({ eventsPath: tracePath });
  const registry = createDefaultAgentRegistry();
  const workspaceRoot = options.safeTrustedRoot(input.workspaceRoot);
  const selected = selectTaskRunner(definition.runnerKind, options, workspaceRoot);
  const securityMode = resolveOrchestratorSecurityMode(options.requestContext);
  const fileSummaryCache = options.fileSummaryCache || defaultFileSummaryCacheFor(options.requestContext);
  const runner = new WorkflowRunner({
    registry,
    trace,
    checkpointStore: createOrchestrationCheckpointStore({ root: options.runStoreRoot }),
    fileSummaryCache,
    taskRunner: selected.taskRunner,
  });
  const run = await runner.run(definition.recipe, {
    runId,
    userGoal: input.userGoal,
    workspaceRoot,
    securityMode,
    refs: input.refs.map(contextRefFromInput),
    signal: options.signal || null,
  });
  const runPath = getRunPath(options.runStoreRoot, run.runId);
  const record: RunRecord = {
    id: run.runId,
    type: 'orchestrator',
    status: run.status,
    provider: providerName(selected.runnerKind),
    mode: run.mode,
    recipeId: run.recipeId,
    context: routeContext(options.requestContext),
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    input: { prompt: input.userGoal, recipeId: input.recipeId, runnerKind: selected.runnerKind, checkpointPath: run.checkpointPath },
    events: trace.list(),
    orchestratorRun: run,
    runPath,
  };
  writeRunRecord(options.runStoreRoot, record);
  indexRun(options.runsIndex, record, options.requestContext);
  return { record, runPath, events: trace.list(), runnerKind: selected.runnerKind };
}

export async function resumeOrchestration(
  runId: string,
  options: RunOrchestrationOptions,
): Promise<{ record: RunRecord; runPath: string; events: OrchestrationEvent[]; runnerKind: OrchestrationRunnerKind }> {
  const checkpointStore = createOrchestrationCheckpointStore({ root: options.runStoreRoot });
  const checkpoint = checkpointStore.load(runId);
  if (!checkpoint) {
    throw httpError(404, 'Orchestrator checkpoint not found', { runId });
  }
  if (TERMINAL_ORCHESTRATOR_STATUSES.has(checkpoint.status)) {
    throw httpError(409, 'Orchestrator checkpoint is terminal and cannot be resumed', {
      runId,
      status: checkpoint.status,
      checkpointPath: checkpoint.checkpointPath,
    });
  }
  const definition = getOrchestrationRecipeDefinition(checkpoint.recipeId as StartOrchestrationInput['recipeId']);
  const workspaceRoot = options.safeTrustedRoot(checkpoint.workspaceRoot);
  const selected = selectTaskRunner(definition.runnerKind, options, workspaceRoot);
  const securityMode = resolveOrchestratorSecurityMode(options.requestContext);
  const fileSummaryCache = options.fileSummaryCache || defaultFileSummaryCacheFor(options.requestContext);
  const trace = new TraceRecorder({ eventsPath: checkpoint.eventsPath || path.join(options.runStoreRoot, `${runId}.events.jsonl`) });
  const runner = new WorkflowRunner({
    registry: createDefaultAgentRegistry(),
    trace,
    checkpointStore,
    fileSummaryCache,
    taskRunner: selected.taskRunner,
  });
  const run = await runner.run(definition.recipe, {
    runId,
    userGoal: checkpoint.userGoal,
    workspaceRoot,
    securityMode,
    refs: checkpoint.refs,
    resumeCheckpoint: { ...checkpoint, workspaceRoot, securityMode },
    signal: options.signal || null,
  });
  const runPath = getRunPath(options.runStoreRoot, run.runId);
  const record: RunRecord = {
    id: run.runId,
    type: 'orchestrator',
    status: run.status,
    provider: providerName(selected.runnerKind),
    mode: run.mode,
    recipeId: run.recipeId,
    context: routeContext(options.requestContext),
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    input: {
      prompt: checkpoint.userGoal,
      recipeId: checkpoint.recipeId,
      runnerKind: selected.runnerKind,
      resumedFromCheckpoint: true,
      checkpointPath: run.checkpointPath,
    },
    events: trace.list(),
    orchestratorRun: run,
    runPath,
  };
  writeRunRecord(options.runStoreRoot, record);
  indexRun(options.runsIndex, record, options.requestContext);
  return { record, runPath, events: trace.list(), runnerKind: selected.runnerKind };
}
export async function runWeeklyReport(
  input: StartOrchestrationInput,
  options: RunWeeklyReportOptions,
): Promise<{ record: RunRecord; runPath: string; events: OrchestrationEvent[] }> {
  const output = await runOrchestration({ ...input, recipeId: 'weekly-report' }, options);
  return { record: output.record, runPath: output.runPath, events: output.events };
}
