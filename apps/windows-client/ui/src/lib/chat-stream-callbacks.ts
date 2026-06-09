// 聊天流回调(UI · lib):构建 Agent SSE 流的事件回调集——把后端事件(消息/工具/审批/进度/收尾)映射成
// 对前端状态的更新与对审批的应答。是 App/hooks 与 api/chat 流之间的胶水。依赖:lib/api + api/chat 类型。
import { respondApproval } from './api';
import type { AgentStreamHandlers } from './api/chat';
import { mergeTodoUpdate } from './app-logic';
import { humanizeError } from './friendly-error';
import type { AssistantMessage, ToolCallItem } from './app-types';

export type AgentMode = 'plan' | 'execute' | 'yolo';

export interface ChatStreamCallbackDeps {
  /** 正在接收流的 assistant 消息 id。 */
  assistantId: string;
  /** App 级消息状态提供的命令式 patch 辅助函数。 */
  patchAssistant: (id: string, fn: (m: AssistantMessage) => AssistantMessage) => void;
  /** 控制「正在流式输出」状态与停止按钮。 */
  setStreamingId: (id: string | null) => void;
  /** 当前 Agent 模式;YOLO 会在审批请求流入时自动批准。 */
  mode: AgentMode;
}

// 纯函数构造 App.tsx 交给 agentChatStream 的 SSE 事件处理器集合。
// 所有状态改写都经 patchAssistant/setStreamingId,因此可独立测试,也不会把 App 再次撑大。
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
      // YOLO 模式:审批请求一到达即自动批准;host 仍会保留其自身高风险审批门语义。
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

/** 工具结束后更新 tools 数组:找到最近同名 running 项并合入状态/结果/耗时/错误。 */
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

/** handleSend catch 分支的友好错误文案入口,集中 action 动词便于后续统一调整。 */
export function humanizeChatTurnError(error: unknown): string {
  return humanizeError(error, { action: '本轮对话' });
}
