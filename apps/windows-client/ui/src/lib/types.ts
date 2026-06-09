// 共享领域类型(UI · lib/types 单一事实来源)
// ---------------------------------------------------------------------------
// 职责:UI 全局共享的领域类型定义(运行记录、事件、审批、待办、文件操作、来源引用等),与 host 的 run/event
//       形状对齐。是跨单元契约在前端的「类型事实来源」(plan/00:类型只在 lib/types)。

export type RunStatus = 'pending' | 'planning' | 'awaiting_approval' | 'applying' | 'done' | 'failed' | 'cancelled';
export type MessageRole = 'user' | 'assistant';
export type ApprovalState = 'idle' | 'awaiting' | 'approved' | 'rejected';
export type TodoStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'rejected';
export type SubtaskStatus = 'running' | 'done' | 'failed';

export interface FileOperation {
  type: 'write' | 'rename' | 'move' | string;
  path?: string | undefined;
  targetPath?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  newName?: string | undefined;
  content?: string | undefined;
  contentBase64?: string | undefined;
  encoding?: string | undefined;
  overwrite?: boolean | undefined;
}

export interface SourceRef {
  path: string;
  relativePath?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  excerpt?: string | undefined;
  error?: string | undefined;
}

export interface ArtifactFile {
  path: string;
  relativePath?: string | undefined;
  size?: number | undefined;
}

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  detail?: string | undefined;
  kind?: string | undefined;
}

export interface SubtaskGroupItem {
  index: number;
  goal: string;
  status: SubtaskStatus;
  stepCount?: number | undefined;
  runId?: string | undefined;
  error?: string | undefined;
}

// host run bus 发出的 SSE 事件载荷。
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
  id?: string | undefined;
  text?: string | undefined;
  icon?: 'check' | 'loader' | string | undefined;
  status?: string | undefined;
  durationMs?: number | undefined;
  operations?: FileOperation[] | undefined;
  count?: number | undefined;
  items?: SourceRef[] | undefined;
  todos?: TodoItem[] | undefined;
  detail?: string | undefined;
  kind?: string | undefined;
  [key: string]: unknown;
}

export interface RunSummary {
  id: string;
  type: string;
  status: RunStatus | string;
  provider?: string | null | undefined;
  mode?: string | null | undefined;
  recipeId?: string | null | undefined;
  promptPreview?: string | null | undefined;
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
  durationMs?: number | null | undefined;
}

export interface TokenUsage {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
}

export interface RunCost {
  currency?: string | undefined;
  input?: number | undefined;
  output?: number | undefined;
  total?: number | undefined;
  estimated?: boolean | undefined;
  source?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
}

export interface RunMetrics {
  schemaVersion?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  status?: string | undefined;
  tokens?: TokenUsage | undefined;
  cost?: RunCost | undefined;
  duration?: {
    totalMs?: number | undefined;
    phases?: Array<{ key?: string | undefined; label?: string | undefined; durationMs?: number | undefined; percent?: number | undefined }>;
    unaccountedMs?: number | undefined;
  } | undefined;
  steps?: {
    total?: number | undefined;
    succeeded?: number | undefined;
    failed?: number | undefined;
  } | undefined;
  tools?: {
    calls?: number | undefined;
    succeeded?: number | undefined;
    failed?: number | undefined;
    unique?: string[] | undefined;
  } | undefined;
  failures?: {
    count?: number | undefined;
    rate?: number | undefined;
    runFailed?: boolean | undefined;
  } | undefined;
}

export interface RunAttribution {
  schemaVersion?: number | undefined;
  prompt?: {
    inputSha256?: string | null | undefined;
    inputChars?: number | undefined;
    systemPromptVersion?: string | null | undefined;
    builder?: string | null | undefined;
  } | undefined;
  model?: {
    provider?: string | null | undefined;
    model?: string | null | undefined;
    mode?: string | null | undefined;
    baseUrl?: string | null | undefined;
  } | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface RunRecord extends RunSummary {
  metrics?: RunMetrics | null | undefined;
  attribution?: RunAttribution | null | undefined;
  prompt?: string | null | undefined;
  input?: { prompt?: string | null | undefined } | undefined;
  result?: unknown | undefined;
  error?: string | { message?: string | undefined } | null | undefined;
  events?: Array<RunEvent | Record<string, unknown>> | undefined;
  sources?: SourceRef[] | undefined;
}
