import path from 'node:path';
import { redactValue } from '../security/redaction.js';
import { AtRestKeyError, openAtRest, sealAtRest } from '../security/at-rest.js';
import {
  ManagedStateFilesystem,
  ManagedStatePathError,
} from '../security/managed-state-filesystem.js';
import type { OrchestrationCheckpoint } from './types.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;
const CHECKPOINT_KEYS = [
  'agents', 'artifacts', 'checkpointPath', 'completedStepIds', 'currentStepId',
  'eventsPath', 'mode', 'recipeId', 'refs', 'results', 'runId', 'securityMode',
  'startedAt', 'status', 'tasks', 'updatedAt', 'userGoal', 'version', 'workspaceRoot',
] as const;
const CHECKPOINT_STRING_KEYS = [
  'currentStepId', 'eventsPath', 'mode', 'recipeId', 'securityMode', 'startedAt',
  'status', 'updatedAt', 'userGoal', 'workspaceRoot',
] as const;
const CHECKPOINT_ARRAY_KEYS = [
  'agents', 'artifacts', 'completedStepIds', 'refs', 'results', 'tasks',
] as const;

export type OrchestrationCheckpointStoreOptions = {
  root: string;
  now?: () => Date;
};

function normalizeRunId(runId: string): string {
  const id = String(runId || '').trim();
  if (!RUN_ID_RE.test(id)) {
    throw new Error('Invalid orchestrator checkpoint run id');
  }
  return id;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isStoredCheckpoint(
  value: unknown,
  expectedRunId: string,
  expectedPath: string,
): value is OrchestrationCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  return keys.length === CHECKPOINT_KEYS.length
    && CHECKPOINT_KEYS.every((key) => Object.hasOwn(record, key))
    && record.version === 1
    && record.runId === expectedRunId
    && record.checkpointPath === expectedPath
    && CHECKPOINT_STRING_KEYS.every((key) => typeof record[key] === 'string')
    && CHECKPOINT_ARRAY_KEYS.every((key) => Array.isArray(record[key]));
}

export function getOrchestrationCheckpointPath(root: string, runId: string): string {
  if (!root || typeof root !== 'string') {
    throw new Error('OrchestrationCheckpointStore: root is required');
  }
  return path.join(root, 'orchestrator-checkpoints', `${normalizeRunId(runId)}.json`);
}

export class OrchestrationCheckpointStore {
  readonly root: string;
  private readonly now: () => Date;
  private readonly filesystem: ManagedStateFilesystem;

  constructor({ root, now = () => new Date() }: OrchestrationCheckpointStoreOptions) {
    if (!root || typeof root !== 'string') {
      throw new Error('OrchestrationCheckpointStore: root is required');
    }
    this.root = root;
    this.now = now;
    this.filesystem = new ManagedStateFilesystem(root, {
      label: 'Orchestrator checkpoint store',
    });
  }

  save(input: OrchestrationCheckpoint): string {
    const runId = normalizeRunId(input.runId);
    const checkpointPath = getOrchestrationCheckpointPath(this.root, runId);
    if (this.filesystem.fileExists(checkpointPath)) {
      let existing: OrchestrationCheckpoint | null;
      try {
        existing = this.load(runId);
      } catch (error) {
        if (error instanceof AtRestKeyError || error instanceof ManagedStatePathError) throw error;
        throw new Error('Orchestrator checkpoint is corrupt or cannot be decrypted');
      }
      if (!existing || existing.runId !== runId) {
        throw new Error('Orchestrator checkpoint could not be verified');
      }
    }
    const sanitized = redactValue(jsonClone(input)) as OrchestrationCheckpoint;
    const checkpoint: OrchestrationCheckpoint = {
      ...sanitized,
      version: 1,
      runId,
      // Structural filesystem paths, not user/model-authored free text: redaction's
      // AppData path pattern (meant to scrub credential-adjacent paths out of logs)
      // would otherwise mangle these, since this app's own data root lives under
      // %APPDATA%\AgentCowork and any real workspace/run path commonly matches it.
      workspaceRoot: input.workspaceRoot,
      eventsPath: input.eventsPath,
      completedStepIds: Array.from(new Set(input.completedStepIds.map((id) => String(id || '').trim()).filter(Boolean))),
      artifacts: Array.from(new Set(input.artifacts.map((artifact) => String(artifact || '').trim()).filter(Boolean))),
      checkpointPath,
      updatedAt: this.now().toISOString(),
    };
    const secDir = path.join(path.dirname(this.root), 'security');
    this.filesystem.writeFile(
      checkpointPath,
      sealAtRest(`${JSON.stringify(checkpoint, null, 2)}\n`, secDir),
    );
    return checkpointPath;
  }

  load(runId: string): OrchestrationCheckpoint | null {
    const checkpointPath = getOrchestrationCheckpointPath(this.root, runId);
    const raw = this.filesystem.readFile(checkpointPath);
    if (raw === null) return null;
    const opened = openAtRest(raw, path.join(path.dirname(this.root), 'security'));
    if (opened === null) return null;
    const parsed: unknown = JSON.parse(opened);
    if (!isStoredCheckpoint(parsed, normalizeRunId(runId), checkpointPath)) {
      throw new Error('Orchestrator checkpoint is corrupt or has a mismatched runId');
    }
    return parsed;
  }
}

export function createOrchestrationCheckpointStore(options: OrchestrationCheckpointStoreOptions): OrchestrationCheckpointStore {
  return new OrchestrationCheckpointStore(options);
}
