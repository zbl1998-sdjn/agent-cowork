import type { ProgressLineProps } from '../components/ProgressLine';
import type { ApprovalState, FileOperation, SourceRef, SubtaskGroupItem, TodoItem } from './types';

export interface PendingApproval { id: string; name: string }

export interface ToolCallItem {
  name: string;
  args?: unknown;
  status: string;
  result?: unknown;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  status: string;
  runId?: string;
  text?: string;
  reasoning?: string;
  progress: ProgressLineProps[];
  operations: FileOperation[];
  fileOperationApprovalId?: string | null;
  rollbackApprovalId?: string | null;
  sources: SourceRef[];
  todos?: TodoItem[];
  subtasks?: SubtaskGroupItem[];
  approvalState: ApprovalState;
  approval?: PendingApproval;
  plan?: { id: string; text: string };
  files?: string[];
  verifying?: boolean;
  question?: { id: string; question: string; options: Array<{ label: string; description?: string }> };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  tools?: ToolCallItem[];
  recipeDraft?: CapturedRecipeDraft;
  recipeCaptureStatus?: 'capturing' | 'captured' | 'failed';
  recipeCaptureError?: string;
}

export interface UserMessage { id: string; role: 'user'; text: string }
export type Message = UserMessage | AssistantMessage;
export interface ConversationBranch {
  id: string;
  title?: string;
  parentBranchId?: string;
  baseMessageId?: string;
  createdAt?: string;
  messages: Message[];
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  pinned?: boolean;
  activeBranchId?: string;
  branches?: ConversationBranch[];
}

export type SidePanel = 'none' | 'tools' | 'viz' | 'connectors' | 'artifacts' | 'projects' | 'schedules' | 'memory' | 'observability';

export interface WorkspaceInfo { trustedRoot: string }
export interface RecipeRunResponse {
  runId: string;
  operations: FileOperation[];
  sources: SourceRef[];
  fileOperationApprovalId?: string | null;
}

export interface CapturedRecipeStep {
  index: number;
  tool: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  summary?: unknown;
}

export interface CapturedRecipeArtifact {
  path: string;
  kind?: string;
  source?: unknown;
}

export interface CapturedRecipeDraft {
  id?: string;
  schemaVersion: number;
  draft: boolean;
  sourceRunId: string;
  name: string;
  description?: string;
  prompt?: string;
  steps: CapturedRecipeStep[];
  artifacts: CapturedRecipeArtifact[];
  redacted: boolean;
}

export interface RecipeCaptureResponse {
  ok: boolean;
  recipe: CapturedRecipeDraft;
}

export interface RecipeSaveResponse {
  ok: boolean;
  recipe: CapturedRecipeDraft & { id: string; custom: true };
}
