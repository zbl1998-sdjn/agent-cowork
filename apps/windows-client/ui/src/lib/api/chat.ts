// 聊天 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:封装普通对话与 Agent 流式对话(SSE),把 token/推理/工具调用/审批/计划/待办/问答/完成等事件分发到 handlers;并提供审批应答、问答应答与运行取消。
// 依赖/对应路由:POST /api/agent-engine/chat(/stream)、/api/agent/chat/stream、/api/approvals/:id、/api/approvals/batch、/api/runs/:id/cancel;经 ./sse(streamSse)。导出:chat / chatStream / agentChatStream / respondApproval(s) / answerQuestion / cancelRun + 相关类型。
import { authHeaders, postJson, requireHost, resolveUrl } from './transport';
import { responseErrorMessage, streamSse, type SsePayload } from './sse';
import { approvalRequestMeta, type ApprovalRequestMeta } from './approval-event';
import type { PermissionMode, TodoItem, TodoStatus } from '../types';
export interface ChatResult {
  ok: boolean;
  text: string;
  model?: string | undefined;
  runId?: string | undefined;
}
export async function chat(
  prompt: string,
  opts: { trustedRoot?: string | undefined; model?: string | undefined; thinking?: string | undefined } = {},
): Promise<ChatResult> {
  return postJson('/api/agent-engine/chat', {
    prompt,
    trustedRoot: opts.trustedRoot,
    model: opts.model,
    thinking: opts.thinking,
  });
}

export interface ChatStreamHandlers {
  onToken?: ((delta: string) => void) | undefined;
  onReasoning?: ((delta: string) => void) | undefined;
  onDone?: ((full: { text: string; runId?: string | undefined; model?: string | undefined }) => void) | undefined;
  onError?: ((message: string) => void) | undefined;
}
function str(data: SsePayload, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

export async function chatStream(
  prompt: string,
  opts: { trustedRoot?: string | undefined; model?: string | undefined; thinking?: string | undefined } = {},
  handlers: ChatStreamHandlers = {},
): Promise<void> {
  await requireHost();
  const response = await fetch(resolveUrl('/api/agent-engine/chat/stream'), {
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

export interface ContextCompactionConfig {
  enabled?: boolean | undefined;
  maxContextTokens?: number | undefined;
  keepRecentMessages?: number | undefined;
  maxFacts?: number | undefined;
}

export interface ContextCompactionStats {
  beforeTokens?: number | undefined;
  afterTokens?: number | undefined;
  keyFacts?: string[] | undefined;
}

export interface AgentStreamHandlers {
  onToken?: ((delta: string) => void) | undefined;
  onApprovalRequest?: ((id: string, name: string, args: unknown, meta?: ApprovalRequestMeta) => void) | undefined;
  onPlanProposed?: ((id: string, plan: string) => void) | undefined;
  onTodoSnapshot?: ((todos: TodoItem[]) => void) | undefined;
  onTodoUpdate?: ((todo: TodoItem) => void) | undefined;
  onReasoning?: ((delta: string) => void) | undefined;
  onToolCall?: ((name: string, args: unknown) => void) | undefined;
  onToolResult?: ((name: string, status: string, result?: unknown, meta?: { durationMs?: number | undefined }) => void) | undefined;
  onFileWritten?: ((path: string) => void) | undefined;
  onVerifyStart?: (() => void) | undefined;
  onQuestion?: ((id: string, question: string, options: Array<{ label: string; description?: string | undefined }>) => void) | undefined;
  onStart?: ((runId: string, meta?: { resumed?: boolean | undefined }) => void) | undefined;
  onContextCompacted?: ((stats: ContextCompactionStats) => void) | undefined;
  onDone?: ((full: { text: string; runId?: string | undefined; usage?: TokenUsage | undefined; stepsExhausted?: boolean | undefined }) => void) | undefined;
  onCancelled?: ((full: { text: string; runId?: string | undefined; usage?: TokenUsage | undefined }) => void) | undefined;
  onError?: ((message: string) => void) | undefined;
}

export interface TokenUsage {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
}

export interface ModelRunConfig {
  provider?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

function usage(data: SsePayload): TokenUsage | undefined {
  return data.usage && typeof data.usage === 'object' ? data.usage as TokenUsage : undefined;
}

function num(data: SsePayload, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringList(data: SsePayload, key: string): string[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function contextCompactionStats(data: SsePayload): ContextCompactionStats {
  return {
    beforeTokens: num(data, 'beforeTokens'),
    afterTokens: num(data, 'afterTokens'),
    keyFacts: stringList(data, 'keyFacts'),
  };
}

function questionOptions(data: SsePayload): Array<{ label: string; description?: string | undefined }> {
  return Array.isArray(data.options) ? data.options as Array<{ label: string; description?: string | undefined }> : [];
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
    trustedRoot?: string | undefined;
    model?: string | undefined;
    modelConfig?: ModelRunConfig | undefined;
    thinking?: string | undefined;
    permissionMode?: PermissionMode | undefined;
    autoApprove?: boolean | undefined;
    planMode?: boolean | undefined;
    images?: string[] | undefined; templateFiles?: string[] | undefined;
    resumeRunId?: string | undefined;
    conversationId?: string | undefined;
    contextCompaction?: ContextCompactionConfig | undefined;
  } = {},
  handlers: AgentStreamHandlers = {},
): Promise<void> {
  await requireHost();
  const response = await fetch(resolveUrl('/api/agent/chat/stream'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      prompt,
      trustedRoot: opts.trustedRoot,
      model: opts.model,
      modelConfig: opts.modelConfig,
      thinking: opts.thinking,
      permissionMode: opts.permissionMode,
      autoApprove: opts.autoApprove,
      planMode: opts.planMode,
      images: opts.images, templateFiles: opts.templateFiles,
      resumeRunId: opts.resumeRunId,
      conversationId: opts.conversationId,
      contextCompaction: opts.contextCompaction,
    }),
  });
  if (!response.ok || !response.body) {
    handlers.onError?.(await responseErrorMessage(response, `agent stream failed (${response.status})`));
    return;
  }
  await streamSse(response, (type, data) => {
    if (type === 'start') handlers.onStart?.(str(data, 'runId') || '', { resumed: data.resumed === true });
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
      handlers.onApprovalRequest?.(str(data, 'id') || '', str(data, 'name') || '', data.args, approvalRequestMeta(data));
    } else if (type === 'tool_result') {
      handlers.onToolResult?.(str(data, 'name') || '', str(data, 'status') || 'succeeded', data.result, { durationMs: num(data, 'durationMs') });
    } else if (type === 'file_written') handlers.onFileWritten?.(str(data, 'path') || '');
    else if (type === 'verify_start') handlers.onVerifyStart?.();
    else if (type === 'context_compacted') handlers.onContextCompacted?.(contextCompactionStats(data));
    else if (type === 'question') {
      handlers.onQuestion?.(str(data, 'id') || '', str(data, 'question') || '', questionOptions(data));
    } else if (type === 'done') {
      handlers.onDone?.({ text: str(data, 'text') || '', runId: str(data, 'runId'), usage: usage(data), stepsExhausted: data.stepsExhausted === true });
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
