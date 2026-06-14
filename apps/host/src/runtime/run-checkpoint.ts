// 运行检查点(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把长任务运行的中间「检查点」(已完成步骤、累计用量、上下文)落盘,使任务可「继续(resume)」而非从头再来。
//       配合 run-resume 实现可取消、可继续(plan/01 健壮性原则)。依赖:node:fs/path。导出:检查点读写函数。

import fs from 'node:fs';
import path from 'node:path';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type CheckpointInput = {
  runId: string;
  step?: number;
  phase?: string;
  messages?: unknown;
  usage?: unknown;
  approvedTools?: unknown;
  todos?: unknown;
  metadata?: unknown;
};

export type RunCheckpoint = {
  version: number;
  runId: string;
  step: number;
  phase: string;
  updatedAt: string;
  messages: unknown[];
  usage: TokenUsage;
  approvedTools: string[];
  todos: unknown[];
  metadata: Record<string, unknown>;
};

export type RunCheckpointerOptions = {
  root?: string;
  now?: () => Date | string;
};

function normalizeRunId(runId: unknown): string {
  const id = String(runId || '').trim();
  if (!RUN_ID_RE.test(id)) {
    throw new Error('Invalid run id');
  }
  return id;
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneArray(value: unknown): unknown[] {
  return Array.isArray(value) ? jsonClone(value) : [];
}

function cloneObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return jsonClone(value as Record<string, unknown>);
}

function normalizeUsage(value: unknown): TokenUsage {
  const usage = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    prompt_tokens: numberOrZero(usage.prompt_tokens),
    completion_tokens: numberOrZero(usage.completion_tokens),
    total_tokens: numberOrZero(usage.total_tokens),
  };
}

function normalizeApprovedTools(value: unknown): string[] {
  const items = value instanceof Set ? Array.from(value) : (Array.isArray(value) ? value : []);
  return Array.from(new Set(items.map((item) => String(item || '').trim()).filter(Boolean))).sort();
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(String(value || ''));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function getCheckpointPath(root: string, runId: string): string {
  if (!root || typeof root !== 'string') {
    throw new Error('RunCheckpointer: root is required');
  }
  const id = normalizeRunId(runId);
  return path.join(root, 'checkpoints', `${id}.json`);
}

export class RunCheckpointer {
  readonly root: string;
  readonly now: () => Date | string;

  constructor({ root, now = () => new Date() }: RunCheckpointerOptions = {}) {
    if (!root || typeof root !== 'string') {
      throw new Error('RunCheckpointer: root is required');
    }
    this.root = root;
    this.now = now;
  }

  save(input: CheckpointInput): string {
    const filePath = getCheckpointPath(this.root, input.runId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const checkpoint: RunCheckpoint = {
      version: 1,
      runId: normalizeRunId(input.runId),
      step: Math.max(0, Math.floor(numberOrZero(input.step))),
      phase: String(input.phase || 'unknown'),
      updatedAt: toIsoString(this.now()),
      messages: cloneArray(input.messages),
      usage: normalizeUsage(input.usage),
      approvedTools: normalizeApprovedTools(input.approvedTools),
      todos: cloneArray(input.todos),
      metadata: cloneObject(input.metadata),
    };
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch { /* 临时文件清理失败时保留原始写入错误 */ }
      throw err;
    }
    return filePath;
  }

  load(runId: string): RunCheckpoint | null {
    const filePath = getCheckpointPath(this.root, runId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunCheckpoint;
  }

  clear(runId: string): boolean {
    const filePath = getCheckpointPath(this.root, runId);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }
}

export function createRunCheckpointer(options: RunCheckpointerOptions = {}): RunCheckpointer {
  return new RunCheckpointer(options);
}
