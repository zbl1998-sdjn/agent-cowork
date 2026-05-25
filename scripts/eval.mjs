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

function readBaseline() {
  if (!fs.existsSync(baselinePath)) return null;
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

function readReplayRecords() {
  const recordsPath = process.env.KCW_EVAL_REPLAY_RECORDS;
  if (!recordsPath) return null;
  const raw = JSON.parse(fs.readFileSync(path.resolve(recordsPath), 'utf8'));
  return Array.isArray(raw) ? raw : raw.records;
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

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-eval-'));
try {
  const tasks = loadAllEvalTasks();
  const replayRecords = readReplayRecords();
  const executor = replayRecords
    ? createOfflineReplayExecutor({ records: replayRecords })
    : async ({ task }) => passingContractResult(task);
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
