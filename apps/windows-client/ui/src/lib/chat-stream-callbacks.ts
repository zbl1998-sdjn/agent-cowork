import { respondApproval } from './api';
import type { AgentStreamHandlers } from './api/chat';
import { mergeTodoUpdate } from './app-logic';
import { humanizeError } from './friendly-error';
import type { AssistantMessage, ToolCallItem } from './app-types';

export type AgentMode = 'plan' | 'execute' | 'yolo';

export interface ChatStreamCallbackDeps {
  /** ID of the assistant message being streamed into. */
  assistantId: string;
  /** Imperative patch helper produced by the App-level message store. */
  patchAssistant: (id: string, fn: (m: AssistantMessage) => AssistantMessage) => void;
  /** Toggles the "is something streaming?" badge / stop button. */
  setStreamingId: (id: string | null) => void;
  /** Current agent mode — YOLO auto-approves every request as it streams. */
  mode: AgentMode;
}

// Pure builder for the 13 SSE event handlers App.tsx hands to agentChatStream.
// Extracted from App.tsx's handleSend so the file stays under the file-size
// soft limit, AND so the callback logic is testable without spinning up React.
//
// All state mutations route through patchAssistant + setStreamingId; the hook
// itself is stateless so it can be re-derived on every render without churning
// the agentChatStream subscription.
export function buildChatStreamCallbacks(deps: ChatStreamCallbackDeps): AgentStreamHandlers {
  const { assistantId, patchAssistant, setStreamingId, mode } = deps;

  const patch = (fn: (m: AssistantMessage) => AssistantMessage) => patchAssistant(assistantId, fn);

  return {
    onStart: (runId) => patch((m) => ({ ...m, runId })),

    onReasoning: (delta) => patch((m) => ({ ...m, reasoning: (m.reasoning || '') + delta })),

    onToolCall: (name, args) => patch((m) => ({
      ...m,
      status: 'running',
      tools: [...(m.tools || []), { name, args, status: 'running', startedAt: Date.now() }],
    })),

    onToolResult: (name, status, result, meta) => patch((m) => ({
      ...m,
      tools: applyToolResult(m.tools, name, status, result, meta?.durationMs),
    })),

    onTodoSnapshot: (todos) => patch((m) => ({ ...m, todos })),

    onTodoUpdate: (todo) => patch((m) => ({ ...m, todos: mergeTodoUpdate(m.todos, todo) })),

    onApprovalRequest: (id, name) => {
      // YOLO mode: auto-approve every request as it streams in (incl. high-risk
      // tools the host's autoApprove gate leaves for explicit confirmation).
      if (mode === 'yolo') { void respondApproval(id, 'once'); return; }
      patch((m) => ({ ...m, approval: { id, name } }));
    },

    onFileWritten: (p) => patch((m) => ({
      ...m,
      files: [...(m.files || []), p].filter((v, i, a) => a.indexOf(v) === i),
    })),

    onVerifyStart: () => patch((m) => ({
      ...m,
      verifying: true,
      progress: [...m.progress, { status: 'running', text: '自检产物中…' }],
    })),

    onQuestion: (id, question, options) => patch((m) => ({
      ...m,
      status: 'awaiting_approval',
      question: { id, question, options },
    })),

    onPlanProposed: (id, plan) => patch((m) => ({
      ...m,
      status: 'awaiting_approval',
      plan: { id, text: plan },
    })),

    onToken: (delta) => patch((m) => ({
      ...m,
      status: 'streaming',
      text: (m.text || '') + delta,
    })),

    onDone: (full) => {
      setStreamingId(null);
      patch((m) => ({
        ...m,
        status: 'done',
        verifying: false,
        text: full.text || m.text || '',
        runId: full.runId || m.runId,
        usage: full.usage || m.usage,
      }));
    },

    onCancelled: (full) => {
      setStreamingId(null);
      patch((m) => ({
        ...m,
        status: 'cancelled',
        verifying: false,
        text: full.text || m.text || '已取消本轮运行。可点击继续发起下一轮。',
        runId: full.runId || m.runId,
        usage: full.usage || m.usage,
      }));
    },

    onError: (msg) => {
      setStreamingId(null);
      patch((m) => ({ ...m, status: 'failed', text: msg }));
    },
  };
}

/**
 * Build the new tools array after a tool finishes. Finds the most recent
 * running entry with the same name and merges in status/result/duration/error.
 * Pure so unit tests can assert the duration + error-extraction logic without
 * touching the SSE plumbing.
 */
export function applyToolResult(
  current: ToolCallItem[] | undefined,
  name: string,
  status: string,
  result: unknown,
  durationMs?: number,
): ToolCallItem[] {
  const tools = [...(current || [])];
  const finishedAt = Date.now();
  const error = result && typeof result === 'object' && 'error' in result
    ? String((result as { error?: unknown }).error || '')
    : undefined;
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const entry = tools[i];
    if (!entry || entry.name !== name || entry.status !== 'running') continue;
    const rawStartedAt = entry.startedAt;
    const startedAtMs = typeof rawStartedAt === 'number' && Number.isFinite(rawStartedAt) ? rawStartedAt : finishedAt;
    tools[i] = {
      ...entry,
      status,
      result,
      finishedAt,
      durationMs: durationMs ?? Math.max(0, finishedAt - startedAtMs),
      ...(error ? { error } : {}),
    };
    break;
  }
  return tools;
}

/**
 * Friendly wrapper for the catch-arm of handleSend. Centralised so future
 * batches can change the action verb in one place.
 */
export function humanizeChatTurnError(error: unknown): string {
  return humanizeError(error, { action: '本轮对话' });
}
