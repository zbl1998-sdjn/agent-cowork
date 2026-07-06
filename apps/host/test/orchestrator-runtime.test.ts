import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BudgetManager,
  ContextPacker,
  FileSummaryCache,
  createDefaultAgentRegistry,
  TraceRecorder,
  transitionRunStatus,
  WorkflowRunner,
  createSubagentTaskRunner,
  createProviderTaskRunner,
  createOrchestrationCheckpointStore,
  listOrchestrationRecipeDefinitions,
} from '../src/orchestrator/index.js';
import { canonicalizePath } from '../src/security/path-policy.js';
import { folderMapReduceRecipe } from '../src/orchestrator/recipes/folder-map-reduce.js';
import { officeTeamRecipe } from '../src/orchestrator/recipes/office-team.js';
import { pptFromFolderRecipe } from '../src/orchestrator/recipes/ppt-from-folder.js';
import { weeklyReportRecipe } from '../src/orchestrator/recipes/weekly-report.js';
import type {
  AgentResult,
  AgentTask,
  AgentUsage,
  ContextPack,
  ContextRef,
  OrchestrationEvent,
} from '../src/orchestrator/index.js';

const ZERO_USAGE: AgentUsage = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  runtimeMs: 0,
  filesRead: 0,
  bytesRead: 0,
};

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-orchestrator-'));
}

function sampleRef(overrides: Partial<ContextRef> = {}): ContextRef {
  return {
    refId: 'source-1',
    kind: 'file',
    label: 'weekly.md',
    dataTags: ['internal'],
    text: 'Done: shipped API key sk-testshouldredact123456789 and finished docs.',
    summary: 'Finished docs.',
    uri: 'file:///weekly.md',
    metadata: {},
    ...overrides,
  };
}

function emptyContextPack(task: AgentTask): ContextPack {
  return {
    contextPackId: 'ctx_empty',
    agentId: task.agentId,
    taskId: task.taskId,
    userGoalSummary: '',
    entries: [],
    forbidden: [],
    redactionReport: { mode: 'none', redactedCount: 0, omittedRefs: 0, truncatedRefs: 0 },
  };
}

function makeResult(task: AgentTask, context: ContextPack, summary = `${task.agentId} ok`): AgentResult {
  return {
    taskId: task.taskId,
    agentId: task.agentId,
    status: 'succeeded',
    summary,
    structured: { summary, contextEntries: context.entries.length },
    evidenceRefs: context.entries.map((entry) => ({ refId: entry.refId, label: entry.label, uri: entry.uri })),
    artifactRefs: [],
    proposedOps: [],
    confidence: 0.9,
    warnings: [],
    usage: { ...ZERO_USAGE, modelCalls: task.budget.maxModelCalls > 0 ? 1 : 0, runtimeMs: 10 },
    nextSuggestedTasks: [],
  };
}

type HandoffEvent = Extract<OrchestrationEvent, { type: 'handoff_started' }>;

function handoffEvents(trace: TraceRecorder): HandoffEvent[] {
  return trace.list().filter((event): event is HandoffEvent => event.type === 'handoff_started');
}

test('AgentRegistry exposes built-in agents and rejects duplicate ids', () => {
  const registry = createDefaultAgentRegistry();
  assert.equal(registry.has('researcher'), true);
  assert.equal(registry.get('writer').contextPolicy.canSeeRawFiles, false);
  assert.throws(() => registry.register(registry.get('researcher')), /already registered/);
  assert.throws(() => registry.get('fallback_agent'), /Unknown agent/);
});

test('ContextPacker enforces data tags, raw visibility, and redaction', () => {
  const registry = createDefaultAgentRegistry();
  const packer = new ContextPacker();
  const researcher = registry.get('researcher');
  const writer = registry.get('writer');

  const researcherPack = packer.pack({
    agent: researcher,
    taskId: 'task_research',
    userGoal: 'weekly report',
    refs: [
      sampleRef(),
      sampleRef({ refId: 'secret-1', dataTags: ['secret'], text: 'secret raw', summary: 'secret summary' }),
    ],
  });
  assert.equal(researcherPack.entries.length, 1);
  assert.match(researcherPack.entries[0]?.text ?? '', /\[REDACTED\]/);
  assert.deepEqual(researcherPack.forbidden, ['secret-1']);

  const writerPack = packer.pack({
    agent: writer,
    taskId: 'task_write',
    userGoal: 'weekly report',
    refs: [sampleRef()],
  });
  assert.equal(writerPack.entries[0]?.text, 'Finished docs.');
});
test('FileSummaryCache reuses file summaries by recipe and agent', async () => {
  const root = tempRoot();
  const registry = createDefaultAgentRegistry();
  const trace = new TraceRecorder();
  const fileSummaryCache = new FileSummaryCache({ now: () => new Date('2026-07-05T00:00:00.000Z') });
  const observed: Array<{ runId: string; agentId: string; hit: boolean; text: string }> = [];
  const runner = new WorkflowRunner({
    registry,
    trace,
    fileSummaryCache,
    taskRunner: async (task, context) => {
      const entry = context.entries[0];
      const cacheInfo = entry?.metadata.summaryCache as { hit?: boolean } | undefined;
      observed.push({
        runId: task.runId,
        agentId: task.agentId,
        hit: cacheInfo?.hit === true,
        text: entry?.text ?? '',
      });
      return makeResult(task, context);
    },
  });
  const firstRef = sampleRef({
    refId: 'same-file',
    uri: 'file:///same.md',
    text: 'Stable source text for cache reuse across orchestrator runs.',
    summary: 'First cached summary.',
  });
  const secondRef = sampleRef({
    refId: 'same-file',
    uri: firstRef.uri,
    text: firstRef.text,
    summary: 'Second supplied summary should not replace cached summary.',
  });

  await runner.run(weeklyReportRecipe, {
    runId: 'run_cache_first',
    userGoal: 'Create a weekly report',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [firstRef],
  });
  await runner.run(weeklyReportRecipe, {
    runId: 'run_cache_second',
    userGoal: 'Create a weekly report',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [secondRef],
  });

  const writerPacks = observed.filter((item) => item.agentId === 'writer');
  assert.equal(writerPacks[0]?.hit, false);
  assert.equal(writerPacks[0]?.text, 'First cached summary.');
  assert.equal(writerPacks[1]?.hit, true);
  assert.equal(writerPacks[1]?.text, 'First cached summary.');
  assert.ok(fileSummaryCache.size() >= 4, 'one cache entry should be stored per recipe agent');
  assert.equal(trace.list().some((event) => event.type === 'summary_cache_updated' && event.runId === 'run_cache_second' && event.hits > 0), true);
});

test('BudgetManager rejects workflows whose task reservation exceeds the run budget', () => {
  const registry = createDefaultAgentRegistry();
  const writer = registry.get('writer');
  const manager = new BudgetManager({
    modelCalls: 0,
    toolCalls: 100,
    inputTokens: 100_000,
    outputTokens: 100_000,
    runtimeMs: 100_000,
    filesRead: 100,
    bytesRead: 100_000,
  });
  const task: AgentTask = {
    taskId: 'task_write',
    runId: 'run_budget',
    parentTaskId: '',
    agentId: 'writer',
    title: 'write',
    instruction: 'write',
    inputRefs: [],
    expectedOutput: 'draft',
    outputSchemaName: writer.outputSchema.name,
    priority: 'normal',
    dependencies: [],
    timeoutMs: writer.budget.maxRuntimeMs,
    budget: writer.budget,
    approvalPolicy: 'never',
  };

  assert.throws(() => manager.assertCanStartTask(task), /modelCalls/);
});

test('WorkflowRunner executes weekly-report recipe through explicit state transitions and JSONL trace', async () => {
  const root = tempRoot();
  const tracePath = path.join(root, 'events.jsonl');
  const registry = createDefaultAgentRegistry();
  const trace = new TraceRecorder({ eventsPath: tracePath });
  const seenTasks: string[] = [];
  const runner = new WorkflowRunner({
    registry,
    trace,
    now: () => new Date('2026-07-05T00:00:00.000Z'),
    taskRunner: async (task, context) => {
      seenTasks.push(task.taskId);
      return makeResult(task, context);
    },
  });

  const run = await runner.run(weeklyReportRecipe, {
    runId: 'run_orchestrator_test',
    userGoal: 'Create a weekly report',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [sampleRef()],
  });

  assert.equal(run.status, 'completed');
  assert.deepEqual(seenTasks, ['task_research', 'task_write', 'task_verify', 'task_security']);
  assert.equal(run.results.length, 4);
  assert.equal(trace.list()[0]?.type, 'run_started');
  assert.equal(trace.list().at(-1)?.type, 'run_completed');
  assert.ok(fs.existsSync(tracePath), 'trace jsonl should be written');
  assert.match(fs.readFileSync(tracePath, 'utf8'), /agent_task_started/);
});

test('WorkflowRunner records controlled handoff events for handoff recipes only', async () => {
  const root = tempRoot();
  const registry = createDefaultAgentRegistry();
  const handoffTrace = new TraceRecorder();
  const handoffRunner = new WorkflowRunner({
    registry,
    trace: handoffTrace,
    now: () => new Date('2026-07-05T00:00:00.000Z'),
    taskRunner: async (task, context) => makeResult(task, context),
  });

  const handoffRun = await handoffRunner.run(officeTeamRecipe, {
    runId: 'run_controlled_handoff_test',
    userGoal: 'Prepare an office handoff',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [sampleRef({ refId: 'office-note', label: 'office.md', summary: 'Office source note.' })],
  });

  assert.equal(handoffRun.status, 'completed');
  const handoffs = handoffEvents(handoffTrace);
  assert.equal(handoffs.length, 6);
  const first = handoffs[0];
  assert.ok(first, 'first handoff event should exist');
  assert.equal(first.taskId, 'task_profile_inputs');
  assert.equal(first.toAgentId, 'excel_helper');
  assert.equal(first.reason, 'Supervisor assigns the source-profile stage before document and deck work.');
  assert.deepEqual(first.contextRefIds, ['office-note']);
  assert.ok(first.budget.maxRuntimeMs > 0, 'handoff event should expose task budget');
  assert.equal('fromAgentId' in first, false);
  const polish = handoffs.find((event) => event.taskId === 'task_polish_doc');
  assert.equal(polish?.fromAgentId, 'excel_helper');
  const security = handoffs.find((event) => event.taskId === 'task_security_review');
  assert.equal(security?.fromAgentId, 'verifier');

  const workflowTrace = new TraceRecorder();
  const workflowRunner = new WorkflowRunner({
    registry,
    trace: workflowTrace,
    taskRunner: async (task, context) => makeResult(task, context),
  });
  await workflowRunner.run(weeklyReportRecipe, {
    runId: 'run_no_handoff_for_workflow',
    userGoal: 'Create a weekly report',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [sampleRef()],
  });
  assert.equal(handoffEvents(workflowTrace).length, 0);
});

test('WorkflowRunner writes redacted checkpoints with completed step state', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const checkpointStore = createOrchestrationCheckpointStore({
    root: runStoreRoot,
    now: () => new Date('2026-07-05T00:00:01.000Z'),
  });
  const registry = createDefaultAgentRegistry();
  const runner = new WorkflowRunner({
    registry,
    checkpointStore,
    now: () => new Date('2026-07-05T00:00:00.000Z'),
    taskRunner: async (task, context) => makeResult(task, context),
  });

  const run = await runner.run(weeklyReportRecipe, {
    runId: 'run_checkpoint_test',
    userGoal: 'Create a weekly report',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [sampleRef()],
  });

  assert.equal(run.status, 'completed');
  assert.ok(run.checkpointPath.endsWith(path.join('orchestrator-checkpoints', 'run_checkpoint_test.json')));
  assert.ok(fs.existsSync(run.checkpointPath), 'orchestrator checkpoint should be written');
  const checkpoint = checkpointStore.load(run.runId);
  assert.ok(checkpoint, 'checkpoint should be readable');
  assert.equal(checkpoint.status, 'completed');
  assert.deepEqual(checkpoint.completedStepIds, ['research', 'write', 'verify', 'security', 'synthesize', 'final_verification']);
  const checkpointText = fs.readFileSync(run.checkpointPath, 'utf8');
  assert.doesNotMatch(checkpointText, /sk-testshouldredact/);
  assert.match(checkpointText, /\[REDACTED\]/);
});

test('WorkflowRunner resumes from a partial checkpoint without rerunning completed steps', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const checkpointStore = createOrchestrationCheckpointStore({ root: runStoreRoot });
  const registry = createDefaultAgentRegistry();
  const researcher = registry.get('researcher');
  const firstTask: AgentTask = {
    taskId: 'task_research',
    runId: 'run_resume_test',
    parentTaskId: '',
    agentId: 'researcher',
    title: 'Collect source evidence',
    instruction: 'Read the supplied source notes and extract verifiable facts.',
    inputRefs: [sampleRef()],
    expectedOutput: 'Evidence-backed bullet summary.',
    outputSchemaName: researcher.outputSchema.name,
    priority: 'normal',
    dependencies: [],
    timeoutMs: researcher.budget.maxRuntimeMs,
    budget: researcher.budget,
    approvalPolicy: 'never',
  };
  checkpointStore.save({
    version: 1,
    runId: 'run_resume_test',
    userGoal: 'Create a weekly report',
    recipeId: weeklyReportRecipe.id,
    mode: weeklyReportRecipe.mode,
    status: 'running',
    workspaceRoot: root,
    securityMode: 'local_strict',
    agents: [...weeklyReportRecipe.agents],
    refs: [sampleRef()],
    tasks: [firstTask],
    results: [makeResult(firstTask, emptyContextPack(firstTask), 'research already completed')],
    completedStepIds: ['research'],
    currentStepId: 'write',
    eventsPath: path.join(runStoreRoot, 'run_resume_test.events.jsonl'),
    checkpointPath: '',
    artifacts: [],
    startedAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  });
  const checkpoint = checkpointStore.load('run_resume_test');
  assert.ok(checkpoint, 'partial checkpoint should be readable');
  const seenTasks: string[] = [];
  const runner = new WorkflowRunner({
    registry,
    checkpointStore,
    now: () => new Date('2026-07-05T00:00:02.000Z'),
    taskRunner: async (task, context) => {
      seenTasks.push(task.taskId);
      return makeResult(task, context);
    },
  });

  const run = await runner.run(weeklyReportRecipe, {
    runId: 'run_resume_test',
    userGoal: checkpoint.userGoal,
    workspaceRoot: root,
    securityMode: checkpoint.securityMode,
    refs: checkpoint.refs,
    resumeCheckpoint: checkpoint,
  });

  assert.equal(run.status, 'completed');
  assert.deepEqual(seenTasks, ['task_write', 'task_verify', 'task_security']);
  assert.equal(run.results.length, 4);
  assert.deepEqual(checkpointStore.load(run.runId)?.completedStepIds, ['research', 'write', 'verify', 'security', 'synthesize', 'final_verification']);
});
test('WorkflowRunner returns a failed run when an agent result misses the typed contract', async () => {
  const registry = createDefaultAgentRegistry();
  const runner = new WorkflowRunner({
    registry,
    now: () => new Date('2026-07-05T00:00:00.000Z'),
    taskRunner: async (task) => ({ ...makeResult(task, emptyContextPack(task)), taskId: 'wrong' }),
  });

  const run = await runner.run(weeklyReportRecipe, {
    runId: 'run_bad_result',
    userGoal: 'Create a weekly report',
    workspaceRoot: tempRoot(),
    securityMode: 'local_strict',
    refs: [sampleRef()],
  });

  assert.equal(run.status, 'failed');
  assert.match(run.results.at(-1)?.summary ?? '', /schema validation/);
});

test('orchestrator status transition table rejects invalid jumps', () => {
  assert.equal(transitionRunStatus('created', 'planning'), 'planning');
  assert.equal(transitionRunStatus('running', 'completed'), 'completed');
  assert.throws(() => transitionRunStatus('completed', 'running'), /Invalid orchestrator transition/);
});



test('recipe registry exposes map-reduce and office-team recipes with registered agents', () => {
  const definitions = listOrchestrationRecipeDefinitions();
  assert.deepEqual(definitions.map((definition) => definition.recipe.id), ['weekly-report', 'folder-map-reduce', 'office-team', 'ppt-from-folder']);
  assert.equal(definitions.find((definition) => definition.recipe.id === 'weekly-report')?.runnerKind, 'deterministic');
  assert.equal(definitions.find((definition) => definition.recipe.id === 'office-team')?.runnerKind, 'subagent');
  assert.equal(folderMapReduceRecipe.mode, 'map_reduce');
  assert.equal(officeTeamRecipe.mode, 'handoff');
  assert.equal(pptFromFolderRecipe.mode, 'handoff');

  const registry = createDefaultAgentRegistry();
  for (const agentId of new Set([...officeTeamRecipe.agents, ...pptFromFolderRecipe.agents])) {
    assert.equal(registry.has(agentId), true, `${agentId} should be registered`);
  }
});

test('Subagent task runner executes bounded read-only SearchWorkspace tool plan', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const registry = createDefaultAgentRegistry();
  const agent = registry.get('researcher');
  const calls: Array<{ name: string; args: Record<string, unknown>; trustedRoot: string }> = [];
  const toolRegistry = {
    has: (name: string) => name === 'SearchWorkspace',
    descriptor: (name: string) => name === 'SearchWorkspace'
      ? { risk: 'low', mutating: false, requiresApproval: false }
      : null,
    call: async (name: string, args: Record<string, unknown>, ctx: { trustedRoot: string }) => {
      calls.push({ name, args, trustedRoot: ctx.trustedRoot });
      return { content: [{ text: 'matched workspace evidence for orchestrator adapter' }] };
    },
  };
  const task: AgentTask = {
    taskId: 'task_subagent_research',
    runId: 'run_parent_orchestrator',
    parentTaskId: '',
    agentId: 'researcher',
    title: 'Map source evidence',
    instruction: 'Find evidence related to the local handoff plan.',
    inputRefs: [sampleRef()],
    expectedOutput: 'Evidence summary.',
    outputSchemaName: agent.outputSchema.name,
    priority: 'normal',
    dependencies: [],
    timeoutMs: agent.budget.maxRuntimeMs,
    budget: agent.budget,
    approvalPolicy: 'never',
  };
  const pack: ContextPack = {
    contextPackId: 'ctx_subagent',
    agentId: 'researcher',
    taskId: task.taskId,
    userGoalSummary: 'Audit the handoff plan',
    entries: [{
      refId: 'handoff',
      kind: 'file',
      label: 'HANDOFF.md',
      dataTags: ['internal'],
      text: 'Subagent adapter must call read-only tools only.',
      truncated: false,
      uri: 'file:///HANDOFF.md',
      metadata: {},
    }],
    forbidden: [],
    redactionReport: { mode: 'secrets_only', redactedCount: 0, omittedRefs: 0, truncatedRefs: 0 },
  };

  const runner = createSubagentTaskRunner({ registry: toolRegistry, trustedRoot: root, runStoreRoot });
  const result = await runner(task, pack, agent);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.structured.runner, 'subagent-adapter');
  assert.match(String(result.structured.subagentRunId || ''), /^run_/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, 'SearchWorkspace');
  // assertTrustedPath canonicalizes the trusted root (resolves Windows 8.3 short
  // names like ADMINI~1 to their real long-form path) before tool calls see it.
  assert.equal(calls[0]?.trustedRoot, canonicalizePath(root));
  assert.ok(fs.existsSync(path.join(runStoreRoot, `${String(result.structured.subagentRunId)}.json`)));
});

test('Provider task runner converts typed provider output into AgentResult', async () => {
  const registry = createDefaultAgentRegistry();
  const agent = registry.get('writer');
  const task: AgentTask = {
    taskId: 'task_provider_write',
    runId: 'run_provider_adapter',
    parentTaskId: '',
    agentId: 'writer',
    title: 'Write provider summary',
    instruction: 'Summarize the packed evidence.',
    inputRefs: [sampleRef()],
    expectedOutput: 'Provider summary.',
    outputSchemaName: agent.outputSchema.name,
    priority: 'normal',
    dependencies: [],
    timeoutMs: agent.budget.maxRuntimeMs,
    budget: agent.budget,
    approvalPolicy: 'never',
  };
  const pack: ContextPack = {
    contextPackId: 'ctx_provider',
    agentId: 'writer',
    taskId: task.taskId,
    userGoalSummary: 'Create a provider-backed report',
    entries: [{
      refId: 'provider-note',
      kind: 'file',
      label: 'provider.md',
      dataTags: ['internal'],
      text: 'Provider adapter should preserve usage and source evidence.',
      truncated: false,
      uri: 'file:///provider.md',
      metadata: {},
    }],
    forbidden: [],
    redactionReport: { mode: 'secrets_only', redactedCount: 0, omittedRefs: 0, truncatedRefs: 0 },
  };
  const seenSignals: Array<AbortSignal | null | undefined> = [];
  const runner = createProviderTaskRunner({
    modelConfig: { provider: 'test-provider', apiKey: 'test-key', model: 'test-model' },
    modelCall: async (args) => {
      seenSignals.push(args.signal);
      return {
        content: 'Provider generated grounded summary.',
        provider: 'test-provider',
        model: 'test-model',
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      };
    },
  });
  const abort = new AbortController();

  const result = await runner(task, pack, agent, { signal: abort.signal });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.structured.runner, 'provider-adapter');
  assert.equal(result.structured.provider, 'test-provider');
  assert.equal(result.usage.modelCalls, 1);
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.evidenceRefs[0]?.refId, 'provider-note');
  assert.equal(seenSignals[0], abort.signal);
});

test('WorkflowRunner runs map-reduce map steps in parallel', async () => {
  const root = tempRoot();
  const registry = createDefaultAgentRegistry();
  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const runner = new WorkflowRunner({
    registry,
    taskRunner: async (task, context) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(task.taskId);
      await new Promise((resolve) => setTimeout(resolve, task.taskId === 'task_map_workspace' ? 30 : 10));
      active -= 1;
      return makeResult(task, context);
    },
  });

  const run = await runner.run(folderMapReduceRecipe, {
    runId: 'run_parallel_map_reduce',
    userGoal: 'Review the workspace with map reduce',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [sampleRef()],
  });

  assert.equal(run.status, 'completed');
  assert.ok(maxActive >= 2, `expected parallel map steps, saw maxActive=${maxActive}`);
  assert.deepEqual(started.slice(0, 2).sort(), ['task_map_git', 'task_map_workspace']);
});

test('WorkflowRunner cooperatively cancels on AbortSignal', async () => {
  const root = tempRoot();
  const registry = createDefaultAgentRegistry();
  const controller = new AbortController();
  const seenTasks: string[] = [];
  const runner = new WorkflowRunner({
    registry,
    taskRunner: async (task, context) => {
      seenTasks.push(task.taskId);
      controller.abort('user cancelled');
      return makeResult(task, context);
    },
  });

  const run = await runner.run(weeklyReportRecipe, {
    runId: 'run_cancelled_orchestrator',
    userGoal: 'Create a weekly report',
    workspaceRoot: root,
    securityMode: 'local_strict',
    refs: [sampleRef()],
    signal: controller.signal,
  });

  assert.equal(run.status, 'cancelled');
  assert.deepEqual(seenTasks, ['task_research']);
  assert.equal(run.results.length, 0);
});
