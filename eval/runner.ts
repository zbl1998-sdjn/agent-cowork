// 评测运行器:逐个执行黄金集任务并聚合打分结果(eval · runner)
// ---------------------------------------------------------------------------
// 职责:校验任务 → 在受信工作根目录写入 fixture 文件 → 调用 executor 执行 →
//       快照工作区并合并产出文件 → 用 scorer 打分 → 捕获异常 → 聚合出通过率汇总。
//       含路径 jail(resolveInside 防止 fixture 越权写到受信根之外)。
// 依赖:tasks/schema 校验、scorers 默认打分器、node:fs/os/path。
//       导出:runEvalTasks 及 EvalExecutor/EvalRunResult 等运行期类型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateEvalTask } from './tasks/schema.js';
import { createDefaultScorer } from './scorers/index.js';
import type { EvalTask } from './tasks/schema.js';
import type { EvalScorerOptions, EvalTaskResult } from './scorers/index.js';

export type EvalExecutorContext = {
  task: EvalTask;
  trustedRoot: string;
  taskIndex: number;
};
export type EvalExecutor = (context: EvalExecutorContext) => EvalTaskResult | Promise<EvalTaskResult>;
export type EvalScorer = {
  score(task: EvalTask, result: EvalTaskResult, options: EvalScorerOptions): unknown;
};
export type EvalRunOptions = {
  tasks?: unknown[];
  executor?: EvalExecutor;
  scorer?: EvalScorer;
  scorerOptions?: EvalScorerOptions;
  workRoot?: string;
};
export type EvalRunResult = {
  taskId: string;
  trustedRoot: string;
  score: unknown;
  result: EvalTaskResult;
  error?: { name: string; message: string; code?: unknown };
};

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveInside(root: string, relativePath: string): string {
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

function writeFixtureFiles(task: EvalTask, trustedRoot: string): void {
  for (const file of task.fixture.files) {
    const target = resolveInside(trustedRoot, file.path);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, file.content, 'utf8');
  }
}

function snapshotWorkspace(root: string, current = root, files: Record<string, string> = {}): Record<string, string> {
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

function mergeResultFiles(workspaceFiles: Record<string, string>, resultFiles: unknown): Record<string, string> {
  if (!resultFiles) return workspaceFiles;
  if (resultFiles instanceof Map) {
    const mapped = Object.fromEntries(Array.from(resultFiles.entries()).map(([filePath, content]) => [
      String(filePath).replace(/\\/g, '/'),
      String(content ?? ''),
    ]));
    return { ...workspaceFiles, ...mapped };
  }
  if (Array.isArray(resultFiles)) {
    const out = { ...workspaceFiles };
    for (const file of resultFiles) {
      if (isObject(file)) out[String(file.path).replace(/\\/g, '/')] = String(file.content ?? '');
    }
    return out;
  }
  if (isObject(resultFiles)) {
    const mapped = Object.fromEntries(Object.entries(resultFiles).map(([filePath, content]) => [
      filePath.replace(/\\/g, '/'),
      String(content ?? ''),
    ]));
    return { ...workspaceFiles, ...mapped };
  }
  return workspaceFiles;
}

function serializeError(error: unknown): { name: string; message: string; code?: unknown } {
  const code = isObject(error) ? error.code : undefined;
  const serialized: { name: string; message: string; code?: unknown } = {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
  if (code !== undefined) serialized.code = code;
  return serialized;
}

function aggregate(results: EvalRunResult[]) {
  const totalTasks = results.length;
  const passedTasks = results.filter((result) => isObject(result.score) && result.score.passed === true).length;
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
}: EvalRunOptions = {}) {
  if (!Array.isArray(tasks)) throw new Error('runEvalTasks requires a tasks array');
  if (typeof executor !== 'function') throw new Error('runEvalTasks requires an executor function');
  ensureDir(workRoot);
  const results: EvalRunResult[] = [];

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
