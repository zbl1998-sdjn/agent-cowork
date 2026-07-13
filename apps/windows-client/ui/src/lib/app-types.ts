// 应用态类型(UI · lib):App 编排层用到的视图模型/会话/UI 状态类型聚合,补充 lib/types 的领域类型。
import type { ApprovalState, FileOperation, SourceRef, SubtaskGroupItem, TodoItem } from './types';
import type { ProgressLineProps } from './types/progress';

export interface PendingApproval {
  id: string;
  name: string;
  risk?: string | undefined;
  preview?: unknown;
  /** Host 明确声明该批准可以按工具名复用于本会话；缺失时失败关闭。 */
  sessionReusable?: boolean | undefined;
  /** 批量回传部分失败时持久化到剩余单卡，避免批量条卸载后丢失错误。 */
  error?: string | undefined;
}

export interface ToolCallItem {
  name: string;
  args?: unknown | undefined;
  status: string;
  result?: unknown | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  status: string;
  runId?: string | undefined;
  text?: string | undefined;
  reasoning?: string | undefined;
  progress: ProgressLineProps[];
  operations: FileOperation[];
  // 该次产物由模型 AI 提取生成(true)还是模板兜底(false/缺省)。用于展示「AI 生成」标识。
  aiGenerated?: boolean | undefined;
  fileOperationApprovalId?: string | null | undefined;
  rollbackApprovalId?: string | null | undefined;
  sources: SourceRef[];
  todos?: TodoItem[] | undefined;
  subtasks?: SubtaskGroupItem[] | undefined;
  approvalState: ApprovalState;
  approval?: PendingApproval | undefined;
  plan?: { id: string; text: string } | undefined;
  files?: string[] | undefined;
  templateFiles?: string[] | undefined;
  verifying?: boolean | undefined;
  question?: { id: string; question: string; options: Array<{ label: string; description?: string | undefined }> } | undefined;
  usage?: { prompt_tokens?: number | undefined; completion_tokens?: number | undefined; total_tokens?: number | undefined } | undefined;
  // 自动续跑到硬上限仍没做完(任务很大)。为 true 时即便 status=done 也允许点【继续】接着做。
  stepsExhausted?: boolean | undefined;
  tools?: ToolCallItem[] | undefined;
  recipeDraft?: CapturedRecipeDraft | undefined;
  recipeCaptureStatus?: 'capturing' | 'captured' | 'failed' | undefined;
  recipeCaptureError?: string | undefined;
}

export interface UserMessage { id: string; role: 'user'; text: string }
export type Message = UserMessage | AssistantMessage;
export interface ConversationBranch {
  id: string;
  title?: string | undefined;
  parentBranchId?: string | undefined;
  baseMessageId?: string | undefined;
  createdAt?: string | undefined;
  messages: Message[];
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  pinned?: boolean | undefined;
  activeBranchId?: string | undefined;
  branches?: ConversationBranch[] | undefined;
}

export type SidePanel = 'none' | 'tasks' | 'tools' | 'viz' | 'connectors' | 'artifacts' | 'projects' | 'schedules' | 'memory' | 'observability';

export interface WorkspaceInfo { trustedRoot: string }
export interface RecipeRunResponse {
  runId: string;
  operations: FileOperation[];
  aiGenerated?: boolean | undefined;
  sources: SourceRef[];
  fileOperationApprovalId?: string | null | undefined;
}

export interface CapturedRecipeStep {
  index: number;
  tool: string;
  status?: string | undefined;
  args?: unknown | undefined;
  result?: unknown | undefined;
  summary?: unknown | undefined;
}

export interface CapturedRecipeArtifact {
  path: string;
  kind?: string | undefined;
  source?: unknown | undefined;
}

export interface CapturedRecipeDraft {
  id?: string | undefined;
  schemaVersion: number;
  draft: boolean;
  sourceRunId: string;
  name: string;
  description?: string | undefined;
  prompt?: string | undefined;
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
