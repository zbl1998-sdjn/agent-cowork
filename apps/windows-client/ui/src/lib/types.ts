// Shared domain types for the UI, aligned with the host's run/event shapes.

export type RunStatus = 'pending' | 'planning' | 'awaiting_approval' | 'applying' | 'done' | 'failed';
export type MessageRole = 'user' | 'assistant';
export type ApprovalState = 'idle' | 'awaiting' | 'approved' | 'rejected';
export type TodoStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'rejected';
export type SubtaskStatus = 'running' | 'done' | 'failed';

export interface FileOperation {
  type: 'write' | 'rename' | 'move' | string;
  path?: string;
  targetPath?: string;
  from?: string;
  to?: string;
  newName?: string;
  content?: string;
  contentBase64?: string;
  encoding?: string;
  overwrite?: boolean;
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

export interface SubtaskGroupItem {
  index: number;
  goal: string;
  status: SubtaskStatus;
  stepCount?: number;
  runId?: string;
  error?: string;
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
    | 'todo_update'
    | 'child_start'
    | 'child_end';
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
  provider?: string | null;
  mode?: string | null;
  recipeId?: string | null;
  promptPreview?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface RunCost {
  currency?: string;
  input?: number;
  output?: number;
  total?: number;
  estimated?: boolean;
  source?: string;
  model?: string;
}

export interface RunMetrics {
  schemaVersion?: number;
  model?: string;
  status?: string;
  tokens?: TokenUsage;
  cost?: RunCost;
  duration?: {
    totalMs?: number;
    phases?: Array<{ key?: string; label?: string; durationMs?: number; percent?: number }>;
    unaccountedMs?: number;
  };
  steps?: {
    total?: number;
    succeeded?: number;
    failed?: number;
  };
  tools?: {
    calls?: number;
    succeeded?: number;
    failed?: number;
    unique?: string[];
  };
  failures?: {
    count?: number;
    rate?: number;
    runFailed?: boolean;
  };
}

export interface RunAttribution {
  schemaVersion?: number;
  prompt?: {
    inputSha256?: string | null;
    inputChars?: number;
    systemPromptVersion?: string | null;
    builder?: string | null;
  };
  model?: {
    provider?: string | null;
    model?: string | null;
    mode?: string | null;
    baseUrl?: string | null;
  };
  config?: Record<string, unknown>;
}

export interface RunRecord extends RunSummary {
  metrics?: RunMetrics | null;
  attribution?: RunAttribution | null;
  prompt?: string | null;
  input?: { prompt?: string | null };
  result?: unknown;
  error?: string | { message?: string } | null;
  events?: Array<RunEvent | Record<string, unknown>>;
  sources?: SourceRef[];
}
