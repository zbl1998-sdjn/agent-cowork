import type { ProgressLineProps } from '../components/ProgressLine';
import type { ApprovalState, FileOperation, SourceRef, TodoItem } from './types';

export interface PendingApproval { id: string; name: string }

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  status: string;
  runId?: string;
  text?: string;
  reasoning?: string;
  progress: ProgressLineProps[];
  operations: FileOperation[];
  sources: SourceRef[];
  todos?: TodoItem[];
  approvalState: ApprovalState;
  approval?: PendingApproval;
  plan?: { id: string; text: string };
  files?: string[];
  verifying?: boolean;
  question?: { id: string; question: string; options: Array<{ label: string; description?: string }> };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  tools?: Array<{ name: string; args?: unknown; status: string; result?: unknown }>;
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

export type SidePanel = 'none' | 'tools' | 'viz' | 'connectors' | 'artifacts' | 'schedules' | 'memory';

export interface WorkspaceInfo { trustedRoot: string }
export interface RecipeRunResponse { runId: string; operations: FileOperation[]; sources: SourceRef[] }
