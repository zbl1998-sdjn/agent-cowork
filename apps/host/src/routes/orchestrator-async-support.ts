import path from 'node:path';
import {
  createOrchestrationCheckpointStore,
} from '../orchestrator/index.js';
import { createRunId, getRunPath, writeRunRecord } from '../runtime/run-store.js';
import {
  contextRefFromInput,
  indexRun,
  providerName,
  routeContext,
  runOrchestration,
  selectTaskRunner,
} from './orchestrator-route-support.js';
import { orchestratorOwner } from './orchestrator-owner-guard.js';
import { resolveOrchestratorSecurityMode } from './orchestrator-security-mode.js';
import { getOrchestrationRecipeDefinition } from '../orchestrator/recipe-registry.js';
import type {
  OrchestrationEvent,
  OrchestrationRun,
} from '../orchestrator/index.js';
import type { OrchestrationRunnerKind } from '../orchestrator/recipe-registry.js';
import type { RunRecord } from '../runtime/run-store.js';
import type { RunOrchestrationOptions, StartOrchestrationInput } from './orchestrator-route-support.js';

export function startAsyncOrchestration(
  input: StartOrchestrationInput,
  options: RunOrchestrationOptions,
): { record: RunRecord; runPath: string; events: OrchestrationEvent[]; runnerKind: OrchestrationRunnerKind } {
  const definition = getOrchestrationRecipeDefinition(input.recipeId);
  const runId = options.runId || createRunId();
  const workspaceRoot = options.safeTrustedRoot(input.workspaceRoot);
  const selected = selectTaskRunner(definition.runnerKind, options, workspaceRoot);
  const securityMode = resolveOrchestratorSecurityMode(options.requestContext);
  const tracePath = path.join(options.runStoreRoot, `${runId}.events.jsonl`);
  const startedAt = new Date().toISOString();
  const checkpointStore = createOrchestrationCheckpointStore({ root: options.runStoreRoot });
  const checkpointPath = checkpointStore.save({
    version: 1,
    runId,
    userGoal: input.userGoal,
    recipeId: definition.recipe.id,
    mode: definition.recipe.mode,
    status: 'running',
    workspaceRoot,
    securityMode,
    agents: [...definition.recipe.agents],
    refs: input.refs.map(contextRefFromInput),
    tasks: [],
    results: [],
    completedStepIds: [],
    currentStepId: 'running',
    eventsPath: tracePath,
    checkpointPath: '',
    artifacts: [],
    startedAt,
    updatedAt: startedAt,
  });
  const run: OrchestrationRun = {
    runId,
    userGoal: input.userGoal,
    recipeId: definition.recipe.id,
    mode: definition.recipe.mode,
    status: 'running',
    workspaceRoot,
    securityMode,
    agents: [...definition.recipe.agents],
    tasks: [],
    results: [],
    eventsPath: tracePath,
    checkpointPath,
    auditPath: '',
    artifacts: [],
    startedAt,
    updatedAt: startedAt,
  };
  const runPath = getRunPath(options.runStoreRoot, runId);
  const record: RunRecord = {
    id: runId,
    type: 'orchestrator',
    status: 'running',
    provider: providerName(selected.runnerKind),
    mode: run.mode,
    recipeId: run.recipeId,
    context: routeContext(options.requestContext),
    startedAt,
    input: { prompt: input.userGoal, recipeId: input.recipeId, runnerKind: selected.runnerKind, checkpointPath },
    events: [],
    orchestratorRun: run,
    runPath,
  };
  writeRunRecord(options.runStoreRoot, record);
  indexRun(options.runsIndex, record, options.requestContext);

  const owner = orchestratorOwner(options.requestContext);
  const controller = options.cancellation?.register?.(runId, owner) || null;
  const signal = controller?.signal || options.signal || null;
  void runOrchestration(input, { ...options, runId, signal }).finally(() => {
    options.cancellation?.done?.(runId, owner);
  });

  return { record, runPath, events: [], runnerKind: selected.runnerKind };
}
