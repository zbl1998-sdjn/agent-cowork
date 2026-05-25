import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvalTask } from './schema.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(ROOT_DIR, 'golden');
const REDTEAM_DIR = path.join(ROOT_DIR, 'redteam');

function jsonFiles(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) jsonFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

export function loadEvalTaskFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error(`Eval task file must contain an array or { tasks }: ${filePath}`);
  }
  return tasks.map(validateEvalTask);
}

export function loadGoldenEvalTasks({ root = TASKS_DIR } = {}) {
  const tasks = jsonFiles(root).flatMap(loadEvalTaskFile);
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`Duplicate EvalTask id: ${task.id}`);
    seen.add(task.id);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadRedteamEvalTasks({ root = REDTEAM_DIR } = {}) {
  return loadGoldenEvalTasks({ root });
}

export function loadAllEvalTasks() {
  const tasks = [...loadGoldenEvalTasks(), ...loadRedteamEvalTasks()];
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`Duplicate EvalTask id: ${task.id}`);
    seen.add(task.id);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
