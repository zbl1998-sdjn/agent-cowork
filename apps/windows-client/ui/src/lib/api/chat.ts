import { authHeaders, hostReady, postJson, resolveUrl } from './transport';
import { responseErrorMessage, streamSse, type SsePayload } from './sse';
import type { TodoItem, TodoStatus } from '../types';

export interface ChatResult {
  ok: boolean;
  text: string;
  model?: string;
  runId?: string;
}

export async function chat(
  prompt: string,
  opts: { trustedRoot?: string; model?: string; thinking?: string } = {},
): Promise<ChatResult> {
  return postJson('/api/kimi/chat', {
    prompt,
    trustedRoot: opts.trustedRoot,
    model: opts.model,
    thinking: opts.thinking,
  });
}

export interface ChatStreamHandlers {
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onDone?: (full: { text: string; runId?: string; model?: string }) => void;
  onError?: (message: string) => void;
}

function str(data: SsePayload, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

export async function chatStream(
  prompt: string,
  opts: { trustedRoot?: string; model?: string; thinking?: string } = {},
  handlers: ChatStreamHandlers = {},
): Promise<void> {
  await hostReady;
  const response = await fetch(resolveUrl('/api/kimi/chat/stream'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt, trustedRoot: opts.trustedRoot, model: opts.model, thinking: opts.thinking }),
  });
  if (!response.ok || !response.body) {
    handlers.onError?.(await responseErrorMessage(response, `stream failed (${response.status})`));
    return;
  }
  await streamSse(response, (type, data) => {
    if (type === 'token') handlers.onToken?.(str(data, 'delta') || '');
    else if (type === 'reasoning') handlers.onReasoning?.(str(data, 'delta') || '');
    else if (type === 'done') {
      handlers.onDone?.({ text: str(data, 'text') || '', runId: str(data, 'runId'), model: str(data, 'model') });
    } else if (type === 'error') {
      handlers.onError?.(str(data, 'error') || 'stream error');
    }
  });
}

export interface AgentStreamHandlers {
  onToken?: (delta: string) => void;
  onApprovalRequest?: (id: string, name: string, args: unknown) => void;
  onPlanProposed?: (id: string, plan: string) => void;
  onTodoSnapshot?: (todos: TodoItem[]) => void;
  onTodoUpdate?: (todo: TodoItem) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (name: string, status: string, result?: unknown, meta?: { durationMs?: number }) => void;
  onFileWritten?: (path: string) => void;
  onVerifyStart?: () => void;
  onQuestion?: (id: string, question: string, options: Array<{ label: string; description?: string }>) => void;
  onStart?: (runId: string) => void;
  onDone?: (full: { text: string; runId?: string; usage?: TokenUsage }) => void;
  onCancelled?: (full: { text: string; runId?: string; usage?: TokenUsage }) => void;
  onError?: (message: string) => void;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ModelRunConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

function usage(data: SsePayload): TokenUsage | undefined {
  return data.usage && typeof data.usage === 'object' ? data.usage as TokenUsage : undefined;
}

function num(data: SsePayload, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function questionOptions(data: SsePayload): Array<{ label: string; description?: string }> {
  return Array.isArray(data.options) ? data.options as Array<{ label: string; description?: string }> : [];
}

const TODO_STATUSES = new Set<TodoStatus>(['pending', 'running', 'done', 'failed', 'blocked', 'rejected']);

function todoStatus(value: unknown): TodoStatus {
  return TODO_STATUSES.has(value as TodoStatus) ? value as TodoStatus : 'pending';
}

function todoItem(data: SsePayload): TodoItem | null {
  const id = str(data, 'id')?.trim();
  const text = str(data, 'text')?.trim();
  if (!id || !text) return null;
  return {
    id,
    text,
    status: todoStatus(data.status),
    ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
    ...(typeof data.kind === 'string' ? { kind: data.kind } : {}),
  };
}

function todoList(data: SsePayload): TodoItem[] {
  if (!Array.isArray(data.todos)) return [];
  return data.todos
    .map((item) => (item && typeof item === 'object' ? todoItem(item as SsePayload) : null))
    .filter((item): item is TodoItem => Boolean(item));
}

export async function agentChatStream(
  prompt: string,
  opts: {
    trustedRoot?: string;
    model?: string;
    modelConfig?: ModelRunConfig;
    thinking?: string;
    autoApprove?: boolean;
    planMode?: boolean;
    images?: string[];
  } = {},
  handlers: AgentStreamHandlers = {},
): Promise<void> {
  await hostReady;
  const response = await fetch(resolveUrl('/api/agent/chat/stream'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      prompt,
      trustedRoot: opts.trustedRoot,
      model: opts.model,
      modelConfig: opts.modelConfig,
      thinking: opts.thinking,
      autoApprove: opts.autoApprove,
      planMode: opts.planMode,
      images: opts.images,
    }),
  });
  if (!response.ok || !response.body) {
    handlers.onError?.(await responseErrorMessage(response, `agent stream failed (${response.status})`));
    return;
  }
  await streamSse(response, (type, data) => {
    if (type === 'start') handlers.onStart?.(str(data, 'runId') || '');
    else if (type === 'token') handlers.onToken?.(str(data, 'delta') || '');
    else if (type === 'reasoning') handlers.onReasoning?.(str(data, 'delta') || '');
    else if (type === 'tool_call') handlers.onToolCall?.(str(data, 'name') || '', data.args);
    else if (type === 'plan_proposed') handlers.onPlanProposed?.(str(data, 'id') || '', str(data, 'plan') || '');
    else if (type === 'todo_snapshot') handlers.onTodoSnapshot?.(todoList(data));
    else if (type === 'todo_update') {
      const item = todoItem(data);
      if (item) handlers.onTodoUpdate?.(item);
    }
    else if (type === 'approval_request') {
      handlers.onApprovalRequest?.(str(data, 'id') || '', str(data, 'name') || '', data.args);
    } else if (type === 'tool_result') {
      handlers.onToolResult?.(str(data, 'name') || '', str(data, 'status') || 'succeeded', data.result, { durationMs: num(data, 'durationMs') });
    } else if (type === 'file_written') handlers.onFileWritten?.(str(data, 'path') || '');
    else if (type === 'verify_start') handlers.onVerifyStart?.();
    else if (type === 'question') {
      handlers.onQuestion?.(str(data, 'id') || '', str(data, 'question') || '', questionOptions(data));
    } else if (type === 'done') {
      handlers.onDone?.({ text: str(data, 'text') || '', runId: str(data, 'runId'), usage: usage(data) });
    } else if (type === 'cancelled') {
      const full = { text: str(data, 'text') || '', runId: str(data, 'runId'), usage: usage(data) };
      if (handlers.onCancelled) handlers.onCancelled(full);
      else handlers.onDone?.(full);
    } else if (type === 'error') handlers.onError?.(str(data, 'error') || 'agent error');
  });
}

export async function respondApproval(id: string, decision: 'once' | 'session' | 'reject'): Promise<boolean> {
  try {
    const res = await postJson<{ ok?: boolean }>(`/api/approvals/${encodeURIComponent(id)}`, { decision });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

export interface ApprovalBatchResult {
  ok: boolean;
  resolved: number;
  results: Array<{ id: string; ok: boolean }>;
}

export async function respondApprovals(ids: string[], decision: 'once' | 'session' | 'reject'): Promise<ApprovalBatchResult> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return { ok: false, resolved: 0, results: [] };
  try {
    const res = await postJson<ApprovalBatchResult>('/api/approvals/batch', { ids: uniqueIds, decision });
    return {
      ok: Boolean(res.ok),
      resolved: Number(res.resolved || 0),
      results: Array.isArray(res.results) ? res.results : [],
    };
  } catch {
    return { ok: false, resolved: 0, results: uniqueIds.map((id) => ({ id, ok: false })) };
  }
}

export async function answerQuestion(id: string, answer: string): Promise<boolean> {
  try {
    const res = await postJson<{ ok?: boolean }>(`/api/approvals/${encodeURIComponent(id)}`, { answer });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

export async function cancelRun(runId: string): Promise<boolean> {
  if (!runId) return false;
  try {
    const res = await postJson<{ cancelled?: boolean }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
    return Boolean(res.cancelled);
  } catch {
    return false;
  }
}
