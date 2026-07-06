import fs from 'node:fs';
import path from 'node:path';
import { redactValue } from '../security/redaction.js';
import type { OrchestrationCheckpoint } from './types.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

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

export function getOrchestrationCheckpointPath(root: string, runId: string): string {
  if (!root || typeof root !== 'string') {
    throw new Error('OrchestrationCheckpointStore: root is required');
  }
  return path.join(root, 'orchestrator-checkpoints', `${normalizeRunId(runId)}.json`);
}

export class OrchestrationCheckpointStore {
  readonly root: string;
  private readonly now: () => Date;

  constructor({ root, now = () => new Date() }: OrchestrationCheckpointStoreOptions) {
    if (!root || typeof root !== 'string') {
      throw new Error('OrchestrationCheckpointStore: root is required');
    }
    this.root = root;
    this.now = now;
  }

  save(input: OrchestrationCheckpoint): string {
    const checkpointPath = getOrchestrationCheckpointPath(this.root, input.runId);
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    const sanitized = redactValue(jsonClone(input)) as OrchestrationCheckpoint;
    const checkpoint: OrchestrationCheckpoint = {
      ...sanitized,
      version: 1,
      runId: normalizeRunId(input.runId),
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
    const tempPath = `${checkpointPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, checkpointPath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch { /* keep the original checkpoint write error */ }
      throw err;
    }
    return checkpointPath;
  }

  load(runId: string): OrchestrationCheckpoint | null {
    const checkpointPath = getOrchestrationCheckpointPath(this.root, runId);
    if (!fs.existsSync(checkpointPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as OrchestrationCheckpoint;
  }
}

export function createOrchestrationCheckpointStore(options: OrchestrationCheckpointStoreOptions): OrchestrationCheckpointStore {
  return new OrchestrationCheckpointStore(options);
}