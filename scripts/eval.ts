#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllEvalTasks } from '../eval/tasks/index.js';
import { runEvalTasks } from '../eval/runner.js';
import { writeEvalReport } from '../eval/report.js';
import { createOfflineReplayExecutor } from '../eval/replay-backend.js';
import type { ModelRecord } from '../apps/host/src/runtime/model-recorder.js';
import type { EvalBaseline } from '../eval/report.js';
import type { EvalExecutor } from '../eval/runner.js';
import type { EvalTask } from '../eval/tasks/schema.js';
import type {
  EvalApproval,
  EvalArtifact,
  EvalBranch,
  EvalTaskResult,
  EvalToolCall,
} from '../eval/scorers/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.join(repoRoot, 'reports', 'eval');
const baselinePath = path.join(repoRoot, 'eval', 'baseline.json');
const scriptPath = fileURLToPath(import.meta.url);
const INVALID_REPLAY_RECORDS_MESSAGE = 'Eval replay records JSON must be an array or { records }';

export type EvalExecutorMode = 'replay' | 'contract';
export type EvalExecutorFromEnvOptions = {
  recordsPath?: string | null;
  allowContractExecutor?: boolean;
};
export type EvalExecutorFromEnvResult = {
  mode: EvalExecutorMode;
  executor: EvalExecutor;
};

function readBaseline(): EvalBaseline | null {
  if (!fs.existsSync(baselinePath)) return null;
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as EvalBaseline;
}

function isReplayRecordsEnvelope(value: unknown): value is { records: unknown[] } {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as { records?: unknown }).records);
}

function asModelRecords(records: unknown[]): ModelRecord[] {
  return records.map((record) => record as ModelRecord);
}

function setExitCode(code: number): void {
  (process as typeof process & { exitCode?: number }).exitCode = code;
}

export function readReplayRecords(
  recordsPath: string | null | undefined = process.env.KCW_EVAL_REPLAY_RECORDS,
): ModelRecord[] | null {
  if (!recordsPath) return null;
  const text = fs.readFileSync(path.resolve(recordsPath), 'utf8').trim();
  if (!text) return [];

  // ModelRecorder exports either a JSON array/envelope or line-delimited records.
  try {
    const raw = JSON.parse(text) as unknown;
    const records = Array.isArray(raw) ? raw : isReplayRecordsEnvelope(raw) ? raw.records : undefined;
    if (!records) throw new Error(INVALID_REPLAY_RECORDS_MESSAGE);
    return asModelRecords(records);
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_REPLAY_RECORDS_MESSAGE) throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ModelRecord);
}

function passingContractResult(task: EvalTask): EvalTaskResult {
  const files = Object.fromEntries(task.fixture.files.map((file) => [file.path, file.content]));
  const responseParts: string[] = [];
  const toolCalls: EvalToolCall[] = [];
  const approvals: EvalApproval[] = [];
  const artifacts: EvalArtifact[] = [];
  const branches: EvalBranch[] = [];
  for (const assertion of task.assertions) {
    if (assertion.type === 'responseContains' && assertion.contains !== undefined) {
      responseParts.push(String(assertion.contains));
    }
    if (assertion.type === 'toolCalled') toolCalls.push({ name: assertion.tool });
    if (assertion.type === 'approvalRequested') approvals.push({ tool: assertion.tool });
    if (assertion.type === 'artifactCreated') artifacts.push({ kind: assertion.kind });
    if (assertion.type === 'conversationBranchExists' && assertion.branch !== undefined) {
      branches.push(String(assertion.branch));
    }
    if (assertion.type === 'fileExists' && assertion.path && !Object.hasOwn(files, assertion.path)) {
      files[assertion.path] = '';
    }
    if (assertion.type === 'fileContains' && assertion.path && assertion.contains !== undefined) {
      files[assertion.path] = `${files[assertion.path] || ''}${String(assertion.contains)}\n`;
    }
    if (assertion.type === 'fileNotExists' && assertion.path) Reflect.deleteProperty(files, assertion.path);
  }
  const steps = Math.max(1, Math.min(task.maxSteps, toolCalls.length + approvals.length + artifacts.length + 1));
  return {
    response: responseParts.join('\n') || `Completed ${task.id}`,
    files,
    toolCalls,
    approvals,
    artifacts,
    branches,
    outsideRootWrites: [],
    steps,
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  };
}

function envFlag(value: unknown): boolean {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

export function createEvalExecutorFromEnv({
  recordsPath = process.env.KCW_EVAL_REPLAY_RECORDS,
  allowContractExecutor = envFlag(process.env.KCW_EVAL_CONTRACT_EXECUTOR),
}: EvalExecutorFromEnvOptions = {}): EvalExecutorFromEnvResult {
  const replayRecords = readReplayRecords(recordsPath);
  if (replayRecords) {
    return { mode: 'replay', executor: createOfflineReplayExecutor({ records: replayRecords }) };
  }
  if (allowContractExecutor) {
    return { mode: 'contract', executor: async ({ task }) => passingContractResult(task) };
  }
  const error = new Error(
    'Eval replay records are required. Set KCW_EVAL_REPLAY_RECORDS to a JSON/JSONL ModelRecorder file, or set KCW_EVAL_CONTRACT_EXECUTOR=1 only for schema/scorer dry-runs.',
  ) as Error & { code: string };
  error.code = 'EVAL_REPLAY_RECORDS_REQUIRED';
  throw error;
}

async function main(): Promise<void> {
  const tasks = loadAllEvalTasks();
  const { mode, executor } = createEvalExecutorFromEnv();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-eval-'));
  try {
    const summary = await runEvalTasks({
      tasks,
      workRoot,
      executor,
    });
    const report = writeEvalReport(summary, {
      outDir: reportDir,
      baseline: readBaseline(),
      regressionTolerance: 0.05,
    });
    console.log(`Eval executor: ${mode}`);
    console.log(`Eval tasks: ${summary.passedTasks}/${summary.totalTasks} passed (${(summary.passRate * 100).toFixed(1)}%)`);
    console.log(`JSON report: ${path.relative(repoRoot, report.jsonPath)}`);
    console.log(`HTML report: ${path.relative(repoRoot, report.htmlPath)}`);
    if (report.json.baseline.regressed) {
      console.error('Eval pass-rate regressed below baseline tolerance.');
      setExitCode(1);
    }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[eval] ${message}`);
    setExitCode(1);
  }
}
