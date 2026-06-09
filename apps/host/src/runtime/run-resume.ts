// 运行续跑(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:基于 run-checkpoint 落下的检查点,把中断的长任务从「上次步骤」续跑而非重头开始(可继续能力)。
// 依赖:同层 run-checkpoint。导出:运行续跑相关函数。

import { createRunCheckpointer } from './run-checkpoint.js';

export type ResumeUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type ResumeState = {
  runId: string;
  step: number;
  phase: string;
  messages: unknown[];
  usage: ResumeUsage;
  approvedTools: string[];
  todos: unknown[];
  metadata: Record<string, unknown>;
  checkpoint: unknown;
};
export type RunCheckpointerLike = { load(runId: string): unknown };
export type RunResumerOptions = { root?: string; checkpointer?: RunCheckpointerLike };

/**
 * 用 JSON 序列化做简单深拷贝,确保续跑状态不会共享检查点对象引用。
 */
function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 把未知值规整成普通对象,让检查点字段读取保持空值安全。
 */
function objectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function usageOrZero(value: unknown): ResumeUsage {
  const usage = objectOrEmpty(value);
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
  };
}

/**
 * 从原始检查点恢复可续跑状态,并对数组/metadata 做深拷贝隔离。
 */
export function resumeStateFromCheckpoint(checkpoint: unknown): ResumeState {
  const record = objectOrEmpty(checkpoint);
  const runId = String(record.runId || '').trim();
  if (!runId) {
    throw new Error('run-resume: checkpoint runId is required');
  }
  const metadata = objectOrEmpty(record.metadata);
  return {
    runId,
    step: Math.max(0, Math.floor(Number(record.step || 0))),
    phase: String(record.phase || 'unknown'),
    messages: Array.isArray(record.messages) ? (jsonClone(record.messages) as unknown[]) : [],
    usage: usageOrZero(record.usage),
    approvedTools: Array.isArray(record.approvedTools) ? record.approvedTools.map((item) => String(item)) : [],
    todos: Array.isArray(record.todos) ? (jsonClone(record.todos) as unknown[]) : [],
    metadata: jsonClone(metadata) as Record<string, unknown>,
    checkpoint: jsonClone(record),
  };
}

export class RunResumer {
  readonly checkpointer: RunCheckpointerLike;

  constructor(options: RunResumerOptions = {}) {
    const { root, checkpointer } = options;
    const resolvedCheckpointer = checkpointer || (root ? createRunCheckpointer({ root }) : null);
    if (!resolvedCheckpointer) {
      throw new Error('RunResumer: root or checkpointer is required');
    }
    this.checkpointer = resolvedCheckpointer;
  }

  load(runId: string): ResumeState | null {
    const checkpoint = this.checkpointer.load(runId);
    return checkpoint ? resumeStateFromCheckpoint(checkpoint) : null;
  }
}

export function createRunResumer(options: RunResumerOptions = {}): RunResumer {
  return new RunResumer(options);
}
