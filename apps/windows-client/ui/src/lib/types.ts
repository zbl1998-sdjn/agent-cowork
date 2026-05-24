// Shared domain types for the UI, aligned with the host's run/event shapes.

export type RunStatus = 'pending' | 'planning' | 'awaiting_approval' | 'applying' | 'done' | 'failed';
export type MessageRole = 'user' | 'assistant';
export type ApprovalState = 'idle' | 'awaiting' | 'approved' | 'rejected';
export type TodoStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'rejected';

export interface FileOperation {
  type: 'write' | 'rename' | 'move' | string;
  path?: string;
  targetPath?: string;
  contentBase64?: string;
}

export interface SourceRef {
  path: string;
  relativePath?: string;
  startLine?: number;
  endLine?: number;
  excerpt?: string;
  error?: string;
}

export interface ArtifactFile {
  path: string;
  relativePath?: string;
  size?: number;
}

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  detail?: string;
  kind?: string;
}

// SSE event payloads emitted by the host run bus.
export interface RunEvent {
  seq: number;
  ts: string;
  type:
    | 'user_message'
    | 'assistant_start'
    | 'progress'
    | 'preview'
    | 'awaiting_approval'
    | 'sources'
    | 'assistant_end'
    | 'sandbox_start'
    | 'sandbox_end'
    | 'tool_result'
    | 'todo_snapshot'
    | 'todo_update';
  id?: string;
  text?: string;
  icon?: 'check' | 'loader' | string;
  status?: string;
  durationMs?: number;
  operations?: FileOperation[];
  count?: number;
  items?: SourceRef[];
  todos?: TodoItem[];
  detail?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface RunSummary {
  id: string;
  type: string;
  status: RunStatus | string;
  recipeId?: string | null;
  promptPreview?: string | null;
  startedAt?: string | null;
  durationMs?: number | null;
}
