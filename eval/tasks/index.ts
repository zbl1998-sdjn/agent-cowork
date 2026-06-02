// 评测任务加载器:从磁盘读取并校验黄金集/红队任务(eval · tasks)
// ---------------------------------------------------------------------------
// 职责:递归扫描 golden/ 与 redteam/ 下的 JSON 任务文件,逐条按 schema 校验,
//       并对任务 id 做去重(防止重复用例),按 id 稳定排序后返回。
// 依赖:tasks/schema 的 validateEvalTask、node:fs/path/url。
//       导出:loadEvalTaskFile、loadGoldenEvalTasks、loadRedteamEvalTasks、loadAllEvalTasks。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvalTask } from './schema.js';
import type { EvalTask } from './schema.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(ROOT_DIR, 'golden');
const REDTEAM_DIR = path.join(ROOT_DIR, 'redteam');

function jsonFiles(root: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) jsonFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function loadEvalTaskFile(filePath: string): EvalTask[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const tasks = Array.isArray(raw) ? raw : isObject(raw) ? raw.tasks : undefined;
  if (!Array.isArray(tasks)) {
    throw new Error(`Eval task file must contain an array or { tasks }: ${filePath}`);
  }
  return tasks.map(validateEvalTask);
}

export function loadGoldenEvalTasks({ root = TASKS_DIR }: { root?: string } = {}): EvalTask[] {
  const tasks = jsonFiles(root).flatMap(loadEvalTaskFile);
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`Duplicate EvalTask id: ${task.id}`);
    seen.add(task.id);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadRedteamEvalTasks({ root = REDTEAM_DIR }: { root?: string } = {}): EvalTask[] {
  return loadGoldenEvalTasks({ root });
}

export function loadAllEvalTasks(): EvalTask[] {
  const tasks = [...loadGoldenEvalTasks(), ...loadRedteamEvalTasks()];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`Duplicate EvalTask id: ${task.id}`);
    seen.add(task.id);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
