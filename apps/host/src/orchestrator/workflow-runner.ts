import { createRunId } from '../runtime/run-store.js';
import { redactText, redactValue } from '../security/redaction.js';
import { BudgetManager } from './budget-manager.js';
import { ContextPacker } from './context-packer.js';
import { GuardrailEngine } from './guardrail-engine.js';
import { createHandoffEvent } from './handoff-controller.js';
import { synthesizeAgentResults } from './result-synthesizer.js';
import { TraceRecorder } from './trace-recorder.js';
import {
  createFailedSystemResult,
  dependenciesOf,
  resultIsComplete,
  sanitizeStepId,
  selectRefs,
  transitionRunStatus,
  validateRecipe,
} from './workflow-state.js';
import type {
  AgentResult,
  AgentTask,
  ContextRef,
  OrchestrationCheckpoint,
  OrchestrationRun,
  OrchestrationStatus,
} from './types.js';
import type { AgentWorkflowStep, OrchestrationRecipe, WorkflowRunInput, WorkflowRunnerOptions, WorkflowStep } from './workflow-types.js';

const TERMINAL_STATUS = new Set<OrchestrationStatus>(['completed', 'cancelled', 'failed']);

class OrchestrationCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationCancelledError';
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRefs(refs: readonly ContextRef[]): ContextRef[] {
  return refs.map((ref) => ({ ...ref, dataTags: [...ref.dataTags], metadata: { ...ref.metadata } }));
}

function cloneCheckpointRefs(refs: readonly ContextRef[]): ContextRef[] {
  return refs.map((ref) => {
    const text = String(redactText(ref.text || ref.summary || '') || '');
    const summary = String(redactText(ref.summary || ref.text.slice(0, 800) || '') || '');
    const metadata = redactValue(ref.metadata) as ContextRef['metadata'];
    return { ...ref, text, summary, dataTags: [...ref.dataTags], metadata };
  });
}

function abortMessage(signal?: AbortSignal | null): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return reason ? String(reason) : 'orchestration cancelled';
}

function assertNotCancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw new OrchestrationCancelledError(abortMessage(signal));
  }
}

function isCancelledError(err: unknown): boolean {
  return err instanceof OrchestrationCancelledError
    || (err instanceof Error && (err.name === 'AbortError' || /abort|cancel/i.test(err.message)));
}

export class WorkflowRunner {
  private readonly taskRunner: WorkflowRunnerOptions['taskRunner'];
  private readonly registry: WorkflowRunnerOptions['registry'];
  private readonly contextPacker: ContextPacker;
  private readonly budgetManager: BudgetManager;
  private readonly guardrails: GuardrailEngine;
  private readonly trace: TraceRecorder;
  private readonly checkpointStore: WorkflowRunnerOptions['checkpointStore'];
  private readonly fileSummaryCache: WorkflowRunnerOptions['fileSummaryCache'];
  private readonly now: () => Date;

  constructor({
    registry,
    taskRunner,
    contextPacker = new ContextPacker(),
    budgetManager = new BudgetManager(),
    guardrails = new GuardrailEngine(),
    trace = new TraceRecorder(),
    checkpointStore,
    fileSummaryCache,
    now = () => new Date(),
  }: WorkflowRunnerOptions) {
    this.registry = registry;
    this.taskRunner = taskRunner;
    this.contextPacker = contextPacker;
    this.budgetManager = budgetManager;
    this.guardrails = guardrails;
    this.trace = trace;
    this.checkpointStore = checkpointStore;
    this.fileSummaryCache = fileSummaryCache;
    this.now = now;
  }

  async run(recipe: OrchestrationRecipe, input: WorkflowRunInput): Promise<OrchestrationRun> {
    validateRecipe(recipe);
    const resumeCheckpoint = input.resumeCheckpoint;
    if (resumeCheckpoint) this.assertResumeCheckpoint(recipe, input, resumeCheckpoint);
    const runId = resumeCheckpoint?.runId || input.runId || createRunId(this.now());
    const startedAt = resumeCheckpoint?.startedAt || this.now().toISOString();
    const refs = cloneRefs(resumeCheckpoint?.refs || input.refs || []);
    let status: OrchestrationStatus = resumeCheckpoint ? 'running' : 'created';
    const tasks: AgentTask[] = resumeCheckpoint ? jsonClone(resumeCheckpoint.tasks) : [];
    const results: AgentResult[] = resumeCheckpoint ? jsonClone(resumeCheckpoint.results) : [];
    const completed = new Set<string>(resumeCheckpoint?.completedStepIds || []);
    const artifacts = new Set<string>(resumeCheckpoint?.artifacts || []);
    let checkpointPath = resumeCheckpoint?.checkpointPath || '';

    const baseRun = (): OrchestrationRun => ({
      runId,
      userGoal: input.userGoal,
      recipeId: recipe.id,
      mode: recipe.mode,
      status,
      workspaceRoot: input.workspaceRoot,
      securityMode: input.securityMode,
      agents: [...recipe.agents],
      tasks,
      results,
      eventsPath: this.trace.eventsPath,
      checkpointPath,
      auditPath: '',
      artifacts: Array.from(artifacts),
      startedAt,
      updatedAt: this.now().toISOString(),
    });

    const saveCheckpoint = (currentStepId = ''): void => {
      if (!this.checkpointStore) return;
      checkpointPath = this.checkpointStore.save({
        version: 1,
        runId,
        userGoal: input.userGoal,
        recipeId: recipe.id,
        mode: recipe.mode,
        status,
        workspaceRoot: input.workspaceRoot,
        securityMode: input.securityMode,
        agents: [...recipe.agents],
        refs: cloneCheckpointRefs(refs),
        tasks: jsonClone(tasks),
        results: jsonClone(results),
        completedStepIds: Array.from(completed),
        currentStepId,
        eventsPath: this.trace.eventsPath,
        checkpointPath,
        artifacts: Array.from(artifacts),
        startedAt,
        updatedAt: this.now().toISOString(),
      });
    };

    try {
      assertNotCancelled(input.signal);
      this.trace.append({ type: 'run_started', runId, goal: input.userGoal, at: this.now().toISOString() });
      this.trace.append({ type: 'recipe_selected', runId, recipeId: recipe.id, reason: recipe.displayName, at: this.now().toISOString() });
      if (!resumeCheckpoint) {
        status = transitionRunStatus(status, 'planning');
        saveCheckpoint('planning');
        status = transitionRunStatus(status, 'running');
      }
      saveCheckpoint(resumeCheckpoint ? 'resume' : 'running');

      while (completed.size < recipe.steps.length) {
        assertNotCancelled(input.signal);
        const runnable = this.runnableSteps(recipe, completed);
        if (runnable.length === 0) {
          throw new Error('Workflow deadlock: no runnable steps');
        }
        const parallelGroup = this.parallelAgentGroup(recipe, runnable);
        if (parallelGroup.length > 1) {
          saveCheckpoint(parallelGroup.map((step) => step.id).join(','));
          await Promise.all(parallelGroup.map((step) => this.runAgentStep(step, {
            runId,
            recipeId: recipe.id,
            mode: recipe.mode,
            input: { ...input, refs },
            tasks,
            results,
            artifacts,
          })));
          assertNotCancelled(input.signal);
          for (const step of parallelGroup) completed.add(step.id);
          saveCheckpoint();
          continue;
        }

        const step = runnable[0];
        if (!step) throw new Error('Workflow deadlock: no runnable steps');
        saveCheckpoint(step.id);
        if (step.kind === 'agent_task') {
          await this.runAgentStep(step, { runId, recipeId: recipe.id, mode: recipe.mode, input: { ...input, refs }, tasks, results, artifacts });
        } else if (step.kind === 'synthesis') {
          status = this.runSynthesisStep(step.id, runId, { ...input, refs }, results, artifacts, status);
        } else {
          status = this.runVerificationStep(step.minimumConfidence ?? 0.5, step.id, runId, results, status);
        }
        assertNotCancelled(input.signal);
        completed.add(step.id);
        saveCheckpoint();
      }
      status = transitionRunStatus(status, 'completed');
      this.trace.append({ type: 'run_completed', runId, status, at: this.now().toISOString() });
      saveCheckpoint();
      return baseRun();
    } catch (err) {
      if (isCancelledError(err)) {
        status = transitionRunStatus(status, 'cancelled');
      } else {
        status = transitionRunStatus(status, 'failed');
        const message = err instanceof Error ? err.message : String(err);
        results.push(createFailedSystemResult(runId, message));
      }
      this.trace.append({ type: 'run_completed', runId, status, at: this.now().toISOString() });
      saveCheckpoint();
      return baseRun();
    }
  }

  private assertResumeCheckpoint(
    recipe: OrchestrationRecipe,
    input: WorkflowRunInput,
    checkpoint: OrchestrationCheckpoint,
  ): void {
    if (checkpoint.recipeId !== recipe.id) {
      throw new Error(`Orchestrator checkpoint recipe mismatch: ${checkpoint.recipeId} != ${recipe.id}`);
    }
    if (input.runId && input.runId !== checkpoint.runId) {
      throw new Error(`Orchestrator checkpoint run id mismatch: ${checkpoint.runId} != ${input.runId}`);
    }
    if (TERMINAL_STATUS.has(checkpoint.status)) {
      throw new Error(`Orchestrator checkpoint is terminal: ${checkpoint.status}`);
    }
    const knownSteps = new Set(recipe.steps.map((step) => step.id));
    for (const stepId of checkpoint.completedStepIds) {
      if (!knownSteps.has(stepId)) {
        throw new Error(`Orchestrator checkpoint references unknown completed step: ${stepId}`);
      }
    }
  }

  private runnableSteps(recipe: OrchestrationRecipe, completed: Set<string>): WorkflowStep[] {
    return recipe.steps.filter((candidate) => (
      !completed.has(candidate.id) && dependenciesOf(candidate).every((dependency) => completed.has(dependency))
    ));
  }

  private parallelAgentGroup(recipe: OrchestrationRecipe, runnable: readonly WorkflowStep[]): AgentWorkflowStep[] {
    if (recipe.mode !== 'map_reduce') return [];
    return runnable.filter((step): step is AgentWorkflowStep => step.kind === 'agent_task');
  }

  private runSynthesisStep(
    stepId: string,
    runId: string,
    input: WorkflowRunInput,
    results: AgentResult[],
    artifacts: Set<string>,
    status: OrchestrationStatus,
  ): OrchestrationStatus {
    const next = transitionRunStatus(status, 'synthesizing');
    this.trace.append({ type: 'synthesis_started', runId, at: this.now().toISOString() });
    const synthesized = synthesizeAgentResults({ userGoal: input.userGoal, agentResults: results });
    artifacts.add(`synthesis:${stepId}`);
    if (synthesized.warnings.length > 0) {
      this.trace.append({
        type: 'verification_completed',
        runId,
        passed: synthesized.confidence >= 0.75,
        warnings: synthesized.warnings,
        at: this.now().toISOString(),
      });
    }
    return transitionRunStatus(next, 'running');
  }

  private runVerificationStep(
    minimumConfidence: number,
    stepId: string,
    runId: string,
    results: AgentResult[],
    status: OrchestrationStatus,
  ): OrchestrationStatus {
    const next = transitionRunStatus(status, 'verifying');
    const warnings = results.flatMap((result) => result.warnings);
    const passed = results.every((result) => result.status !== 'failed')
      && results.every((result) => result.confidence >= minimumConfidence);
    this.trace.append({ type: 'verification_completed', runId, passed, warnings, at: this.now().toISOString() });
    if (!passed) {
      throw new Error(`Workflow verification failed at ${stepId}`);
    }
    return transitionRunStatus(next, 'running');
  }

  private async runAgentStep(
    step: AgentWorkflowStep,
    state: {
      runId: string;
      recipeId: string;
      mode: OrchestrationRecipe['mode'];
      input: WorkflowRunInput;
      tasks: AgentTask[];
      results: AgentResult[];
      artifacts: Set<string>;
    },
  ): Promise<void> {
    assertNotCancelled(state.input.signal);
    const agent = this.registry.get(step.agentId);
    const task: AgentTask = {
      taskId: `task_${sanitizeStepId(step.id)}`,
      runId: state.runId,
      parentTaskId: '',
      agentId: step.agentId,
      title: step.title,
      instruction: step.instruction,
      inputRefs: selectRefs(step, state.input.refs ?? []),
      expectedOutput: step.expectedOutput,
      outputSchemaName: agent.outputSchema.name,
      priority: 'normal',
      dependencies: dependenciesOf(step),
      timeoutMs: step.timeoutMs ?? agent.budget.maxRuntimeMs,
      budget: step.budget ?? agent.budget,
      approvalPolicy: step.approvalPolicy ?? 'never',
    };
    this.guardrails.beforeTask({ agent, task, securityMode: state.input.securityMode });
    this.budgetManager.assertCanStartTask(task);
    this.trace.append({ type: 'budget_updated', runId: state.runId, budget: this.budgetManager.snapshot(), at: this.now().toISOString() });
    const cacheResolution = this.fileSummaryCache?.resolveRefs({
      refs: task.inputRefs,
      skillId: state.recipeId,
      agentId: task.agentId,
    });
    if (cacheResolution) {
      task.inputRefs = cacheResolution.refs;
      if (cacheResolution.hits > 0 || cacheResolution.misses > 0) {
        this.trace.append({
          type: 'summary_cache_updated',
          runId: state.runId,
          taskId: task.taskId,
          agentId: task.agentId,
          hits: cacheResolution.hits,
          misses: cacheResolution.misses,
          stores: cacheResolution.stores,
          cacheKeys: cacheResolution.cacheKeys,
          at: this.now().toISOString(),
        });
      }
    }
    const handoffEvent = createHandoffEvent({
      mode: state.mode,
      runId: state.runId,
      step,
      task,
      results: state.results,
      at: this.now().toISOString(),
    });
    if (handoffEvent) this.trace.append(handoffEvent);
    const pack = this.contextPacker.pack({ agent, taskId: task.taskId, userGoal: state.input.userGoal, refs: task.inputRefs });
    this.trace.append({ type: 'agent_task_started', runId: state.runId, taskId: task.taskId, agentId: task.agentId, title: task.title, at: this.now().toISOString() });
    state.tasks.push(task);
    const result = await this.taskRunner(task, pack, agent, { signal: state.input.signal });
    assertNotCancelled(state.input.signal);
    if (!resultIsComplete(result, task)) {
      throw new Error(`Agent result failed schema validation for ${task.taskId}`);
    }
    state.results.push(result);
    for (const artifact of result.artifactRefs) {
      state.artifacts.add(artifact);
    }
    this.budgetManager.recordResult(result);
    this.trace.append({ type: 'budget_updated', runId: state.runId, budget: this.budgetManager.snapshot(), at: this.now().toISOString() });
    if (result.status === 'failed') {
      this.trace.append({ type: 'agent_task_failed', runId: state.runId, taskId: task.taskId, agentId: task.agentId, error: result.summary, fallbackUsed: false, at: this.now().toISOString() });
      throw new Error(`Agent task failed: ${task.taskId}`);
    }
    this.trace.append({ type: 'agent_task_completed', runId: state.runId, taskId: task.taskId, agentId: task.agentId, status: result.status, summary: result.summary, at: this.now().toISOString() });
  }
}