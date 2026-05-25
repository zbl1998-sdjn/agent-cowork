import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateEvalTask } from './tasks/schema.js';
import { createDefaultScorer } from './scorers/index.js';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveInside(root, relativePath) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, relativePath);
  const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  const comparableTarget = targetPath.toLowerCase();
  const comparableRoot = rootPath.toLowerCase();
  const comparablePrefix = rootPrefix.toLowerCase();
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(comparablePrefix)) {
    throw new Error(`Eval fixture path escapes trusted root: ${relativePath}`);
  }
  return targetPath;
}

function writeFixtureFiles(task, trustedRoot) {
  for (const file of task.fixture.files) {
    const target = resolveInside(trustedRoot, file.path);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, file.content, 'utf8');
  }
}

function snapshotWorkspace(root, current = root, files = {}) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      snapshotWorkspace(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
    files[relativePath] = fs.readFileSync(fullPath, 'utf8');
  }
  return files;
}

function mergeResultFiles(workspaceFiles, resultFiles) {
  if (!resultFiles) return workspaceFiles;
  if (resultFiles instanceof Map) {
    return { ...workspaceFiles, ...Object.fromEntries(resultFiles.entries()) };
  }
  if (Array.isArray(resultFiles)) {
    const out = { ...workspaceFiles };
    for (const file of resultFiles) out[String(file.path).replace(/\\/g, '/')] = String(file.content ?? '');
    return out;
  }
  if (typeof resultFiles === 'object') {
    return { ...workspaceFiles, ...resultFiles };
  }
  return workspaceFiles;
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code,
  };
}

function aggregate(results) {
  const totalTasks = results.length;
  const passedTasks = results.filter((result) => result.score.passed).length;
  const failedTasks = totalTasks - passedTasks;
  return {
    totalTasks,
    passedTasks,
    failedTasks,
    passRate: totalTasks === 0 ? 0 : passedTasks / totalTasks,
    results,
  };
}

export async function runEvalTasks({
  tasks,
  executor,
  scorer = createDefaultScorer(),
  scorerOptions = {},
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-eval-')),
} = {}) {
  if (!Array.isArray(tasks)) throw new Error('runEvalTasks requires a tasks array');
  if (typeof executor !== 'function') throw new Error('runEvalTasks requires an executor function');
  ensureDir(workRoot);
  const results = [];

  for (const [index, rawTask] of tasks.entries()) {
    const task = validateEvalTask(rawTask);
    const trustedRoot = fs.mkdtempSync(path.join(workRoot, `${task.id}-`));
    writeFixtureFiles(task, trustedRoot);
    try {
      const startedAt = Date.now();
      const execution = await executor({ task, trustedRoot, taskIndex: index });
      const finishedAt = Date.now();
      const workspaceFiles = snapshotWorkspace(trustedRoot);
      const result = {
        ...execution,
        files: mergeResultFiles(workspaceFiles, execution?.files),
        latencyMs: execution?.latencyMs ?? finishedAt - startedAt,
      };
      results.push({
        taskId: task.id,
        trustedRoot,
        score: scorer.score(task, result, scorerOptions),
        result,
      });
    } catch (error) {
      const result = {
        response: '',
        files: snapshotWorkspace(trustedRoot),
        toolCalls: [],
        steps: 0,
        latencyMs: 0,
        usage: {},
      };
      results.push({
        taskId: task.id,
        trustedRoot,
        error: serializeError(error),
        score: scorer.score(task, result, scorerOptions),
        result,
      });
    }
  }

  return aggregate(results);
}
