import type { ApprovalState, RunEvent, SourceRef, TodoItem, TodoStatus } from './types';

export type ProgressStatus = 'pending' | 'running' | 'done' | 'failed' | 'wait';

export interface ProgressEntry {
  status?: ProgressStatus;
  icon?: string;
  text: string;
  duration?: string;
}

export interface AssistantRunState {
  status: string;
  progress: ProgressEntry[];
  sources: SourceRef[];
  todos?: TodoItem[];
  approvalState: ApprovalState;
}

export function progressStatusFromIcon(icon?: string): ProgressStatus {
  if (icon === 'check') return 'done';
  if (icon === 'loader') return 'running';
  return 'wait';
}

const TODO_STATUSES = new Set<TodoStatus>(['pending', 'running', 'done', 'failed', 'blocked', 'rejected']);

function normalizeTodoStatus(status: unknown): TodoStatus {
  return TODO_STATUSES.has(status as TodoStatus) ? status as TodoStatus : 'pending';
}

function todoFromUnknown(value: unknown): TodoItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!id || !text) return null;
  return {
    id,
    text,
    status: normalizeTodoStatus(raw.status),
    ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
  };
}

export function mergeTodoUpdate(current: TodoItem[] = [], update: unknown): TodoItem[] {
  const item = todoFromUnknown(update);
  if (!item) return current;
  const index = current.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...current, item];
  return current.map((existing, i) => (i === index ? { ...existing, ...item } : existing));
}

export function reduceAssistantRunEvent<T extends AssistantRunState>(message: T, event: RunEvent): T {
  const next = { ...message };
  if (event.type === 'progress') {
    next.progress = [...message.progress, { status: progressStatusFromIcon(event.icon), text: event.text || '处理中' }];
  } else if (event.type === 'tool_result') {
    const ok = event.status === 'succeeded';
    next.progress = [
      ...message.progress,
      { status: ok ? 'done' : 'failed', text: `${ok ? '完成' : '失败'}: ${String(event.tool ?? '')}` },
    ];
  } else if (event.type === 'sources' && Array.isArray(event.items)) {
    next.sources = event.items;
  } else if (event.type === 'todo_snapshot' && Array.isArray(event.todos)) {
    next.todos = event.todos.map(todoFromUnknown).filter((item): item is TodoItem => Boolean(item));
  } else if (event.type === 'todo_update') {
    next.todos = mergeTodoUpdate(message.todos || [], event);
  } else if (event.type === 'awaiting_approval') {
    next.status = 'awaiting_approval';
    next.approvalState = 'awaiting';
  } else if (event.type === 'assistant_end') {
    next.status = event.status === 'failed' ? 'failed' : 'done';
  }
  return next;
}

export function reconcileChatEnabled(
  current: boolean,
  refreshed?: { chatEnabled?: boolean } | null,
): { enabled: boolean; shouldUpdateState: boolean } {
  if (current) return { enabled: true, shouldUpdateState: false };
  const enabled = Boolean(refreshed?.chatEnabled);
  return { enabled, shouldUpdateState: enabled };
}
