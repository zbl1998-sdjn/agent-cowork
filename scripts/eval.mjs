#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllEvalTasks } from '../eval/tasks/index.js';
import { runEvalTasks } from '../eval/runner.js';
import { writeEvalReport } from '../eval/report.js';
import { createOfflineReplayExecutor } from '../eval/replay-backend.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.join(repoRoot, 'reports', 'eval');
const baselinePath = path.join(repoRoot, 'eval', 'baseline.json');
const scriptPath = fileURLToPath(import.meta.url);

function readBaseline() {
  if (!fs.existsSync(baselinePath)) return null;
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

export function readReplayRecords(recordsPath = process.env.KCW_EVAL_REPLAY_RECORDS) {
  if (!recordsPath) return null;
  const text = fs.readFileSync(path.resolve(recordsPath), 'utf8').trim();
  if (!text) return [];
  try {
    const raw = JSON.parse(text);
    const records = Array.isArray(raw) ? raw : raw.records;
    if (!Array.isArray(records)) throw new Error('Eval replay records JSON must be an array or { records }');
    return records;
  } catch (error) {
    if (error.message === 'Eval replay records JSON must be an array or { records }') throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function passingContractResult(task) {
  const files = Object.fromEntries(task.fixture.files.map((file) => [file.path, file.content]));
  const responseParts = [];
  const toolCalls = [];
  const approvals = [];
  const artifacts = [];
  const branches = [];
  for (const assertion of task.assertions) {
    if (assertion.type === 'responseContains') responseParts.push(assertion.contains);
    if (assertion.type === 'toolCalled') toolCalls.push({ name: assertion.tool });
    if (assertion.type === 'approvalRequested') approvals.push({ tool: assertion.tool });
    if (assertion.type === 'artifactCreated') artifacts.push({ kind: assertion.kind });
    if (assertion.type === 'conversationBranchExists') branches.push(assertion.branch);
    if (assertion.type === 'fileExists' && !Object.hasOwn(files, assertion.path)) files[assertion.path] = '';
    if (assertion.type === 'fileContains') files[assertion.path] = `${files[assertion.path] || ''}${assertion.contains}\n`;
    if (assertion.type === 'fileNotExists') delete files[assertion.path];
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

function envFlag(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

export function createEvalExecutorFromEnv({
  recordsPath = process.env.KCW_EVAL_REPLAY_RECORDS,
  allowContractExecutor = envFlag(process.env.KCW_EVAL_CONTRACT_EXECUTOR),
} = {}) {
  const replayRecords = readReplayRecords(recordsPath);
  if (replayRecords) {
    return { mode: 'replay', executor: createOfflineReplayExecutor({ records: replayRecords }) };
  }
  if (allowContractExecutor) {
    return { mode: 'contract', executor: async ({ task }) => passingContractResult(task) };
  }
  const error = new Error(
    'Eval replay records are required. Set KCW_EVAL_REPLAY_RECORDS to a JSON/JSONL ModelRecorder file, or set KCW_EVAL_CONTRACT_EXECUTOR=1 only for schema/scorer dry-runs.',
  );
  error.code = 'EVAL_REPLAY_RECORDS_REQUIRED';
  throw error;
}

async function main() {
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
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    console.error(`[eval] ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
