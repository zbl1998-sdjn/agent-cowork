// 运行检查点(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把长任务运行的中间「检查点」(已完成步骤、累计用量、上下文)落盘,使任务可「继续(resume)」而非从头再来。
//       配合 run-resume 实现可取消、可继续(plan/01 健壮性原则)。依赖:node:fs/path。导出:检查点读写函数。
import path from 'node:path';
import { openAtRest, sealAtRest } from '../security/at-rest.js';
import { ManagedStateFilesystem } from '../security/managed-state-filesystem.js';
import {
  ensureRunOwnerClaim,
  isLocalRunOwner,
  normalizeRunOwner,
  sameRunOwner,
  type RunOwner,
} from '../util/run-owner.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;
const RUN_CHECKPOINT_V1_KEYS = [
  'approvedTools', 'messages', 'metadata', 'phase', 'runId',
  'step', 'todos', 'updatedAt', 'usage', 'version',
] as const;
export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type CheckpointInput = {
  runId: string;
  owner?: unknown;
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
  owner?: RunOwner;
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

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function isPersistedRunCheckpoint(value: unknown, expectedRunId: string): value is RunCheckpoint {
  const record = plainRecord(value);
  if (!record || (record.version !== 1 && record.version !== 2)) return false;
  const keys = record.version === 1
    ? RUN_CHECKPOINT_V1_KEYS
    : [...RUN_CHECKPOINT_V1_KEYS, 'owner'];
  const usage = plainRecord(record.usage);
  if (!exactKeys(record, keys) || !usage || !exactKeys(usage, [
    'prompt_tokens', 'completion_tokens', 'total_tokens',
  ])) return false;
  if (record.version === 2) {
    try { normalizeRunOwner(record.owner, { label: 'Stored checkpoint owner' }); } catch { return false; }
  }
  const updatedAt = record.updatedAt;
  return record.runId === expectedRunId
    && Number.isInteger(record.step) && Number(record.step) >= 0
    && typeof record.phase === 'string' && record.phase.length > 0
    && typeof updatedAt === 'string'
    && !Number.isNaN(Date.parse(updatedAt)) && new Date(updatedAt).toISOString() === updatedAt
    && Array.isArray(record.messages)
    && Array.isArray(record.approvedTools) && record.approvedTools.every((tool) => typeof tool === 'string')
    && Array.isArray(record.todos)
    && plainRecord(record.metadata) !== null
    && ['prompt_tokens', 'completion_tokens', 'total_tokens']
      .every((key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]));
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

export function checkpointOwnedBy(checkpoint: unknown, expectedOwner: RunOwner): boolean {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
  const record = checkpoint as Record<string, unknown>;
  if (!Object.hasOwn(record, 'owner')) return isLocalRunOwner(expectedOwner);
  try {
    return sameRunOwner(
      normalizeRunOwner(record.owner, { label: 'Stored checkpoint owner' }),
      expectedOwner,
    );
  } catch {
    return false;
  }
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
  private readonly filesystem: ManagedStateFilesystem;

  constructor({ root, now = () => new Date() }: RunCheckpointerOptions = {}) {
    if (!root || typeof root !== 'string') {
      throw new Error('RunCheckpointer: root is required');
    }
    this.root = root;
    this.now = now;
    this.filesystem = new ManagedStateFilesystem(root, { label: 'Run checkpoint store' });
  }

  save(input: CheckpointInput): string {
    const runId = normalizeRunId(input.runId);
    const filePath = getCheckpointPath(this.root, runId);
    const owner = normalizeRunOwner(input.owner, {
      allowLocalDefault: true,
      label: 'Run checkpoint owner',
    });
    if (this.filesystem.fileExists(filePath)) {
      const existing = this.load(input.runId);
      if (!existing) throw new Error('Run checkpoint owner could not be verified');
      if (!checkpointOwnedBy(existing, owner)) throw new Error('Run checkpoint owner mismatch');
    }
    const claimPath = path.join(path.dirname(filePath), '.owners', `${runId}.json`);
    ensureRunOwnerClaim({
      claimPath,
      owner,
      label: 'Run checkpoint',
      beforeFilesystemMutation: this.filesystem.guardMutation,
      boundary: this.filesystem.boundary,
    });
    this.filesystem.guardMutation(claimPath);
    const checkpoint: RunCheckpoint = {
      version: 2,
      runId,
      owner,
      step: Math.max(0, Math.floor(numberOrZero(input.step))),
      phase: String(input.phase || 'unknown'),
      updatedAt: toIsoString(this.now()),
      messages: cloneArray(input.messages),
      usage: normalizeUsage(input.usage),
      approvedTools: normalizeApprovedTools(input.approvedTools),
      todos: cloneArray(input.todos),
      metadata: cloneObject(input.metadata),
    };
    const secDir = path.join(path.dirname(this.root), 'security');
    this.filesystem.writeFile(
      filePath,
      sealAtRest(`${JSON.stringify(checkpoint, null, 2)}\n`, secDir),
    );
    return filePath;
  }

  load(runId: string): RunCheckpoint | null {
    const filePath = getCheckpointPath(this.root, runId);
    const raw = this.filesystem.readFile(filePath);
    if (raw === null) return null;
    const opened = openAtRest(raw, path.join(path.dirname(this.root), 'security'));
    if (opened === null) return null;
    const parsed: unknown = JSON.parse(opened);
    if (!isPersistedRunCheckpoint(parsed, normalizeRunId(runId))) {
      throw new Error('Run checkpoint is corrupt or has a mismatched runId');
    }
    return parsed;
  }

  clear(runId: string): boolean {
    const filePath = getCheckpointPath(this.root, runId);
    return this.filesystem.removeFile(filePath);
  }
}

export function createRunCheckpointer(options: RunCheckpointerOptions = {}): RunCheckpointer {
  return new RunCheckpointer(options);
}
