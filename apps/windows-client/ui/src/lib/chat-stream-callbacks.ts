// 聊天流回调(UI · lib):构建 Agent SSE 流的事件回调集——把后端事件(消息/工具/审批/进度/收尾)映射成
// 对前端状态的更新。是 App/hooks 与 api/chat 流之间的胶水。依赖:api/chat 类型。
import type { AgentStreamHandlers, ContextCompactionStats } from './api/chat';
import { mergeTodoUpdate } from './app-logic';
import { humanizeError } from './friendly-error';
import type { AssistantMessage, ToolCallItem } from './app-types';

function formatTokenCount(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return value >= 1000 ? `${Math.round(value / 100) / 10}K tokens` : `${Math.round(value)} tokens`;
}

export function contextCompactionProgressText(stats: ContextCompactionStats): string {
  const before = formatTokenCount(stats.beforeTokens);
  const after = formatTokenCount(stats.afterTokens);
  if (before && after) return `已自动压缩上下文:${before} -> ${after}`;
  return '已自动压缩上下文';
}
export interface ChatStreamCallbackDeps {
  /** 正在接收流的 assistant 消息 id。 */
  assistantId: string;
  /** App 级消息状态提供的命令式 patch 辅助函数。 */
  patchAssistant: (id: string, fn: (m: AssistantMessage) => AssistantMessage) => void;
  /** 控制「正在流式输出」状态与停止按钮。 */
  setStreamingId: (id: string | null) => void;
}

// 纯函数构造 App.tsx 交给 agentChatStream 的 SSE 事件处理器集合。
// 所有状态改写都经 patchAssistant/setStreamingId,因此可独立测试,也不会把 App 再次撑大。
export function buildChatStreamCallbacks(deps: ChatStreamCallbackDeps): AgentStreamHandlers {
  const { assistantId, patchAssistant, setStreamingId } = deps;

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

    onApprovalRequest: (id, name, _args, meta) => {
      // host 只有在操作必须由人决定时才发 approval_request；UI 不得自动代答。
      patch((m) => ({
        ...m,
        approval: {
          id,
          name,
          risk: meta?.risk,
          preview: meta?.preview,
          sessionReusable: meta?.sessionReusable === true,
          workspacePersistable: meta?.workspacePersistable === true,
        },
      }));
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

    onContextCompacted: (stats) => patch((m) => ({
      ...m,
      progress: [...m.progress, { status: 'done', text: contextCompactionProgressText(stats) }],
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
      // 自动续跑到硬上限仍没做完(任务很大):标记 stepsExhausted 并追加一句提示,让底部出现【继续】。
      const exhausted = full.stepsExhausted === true;
      patch((m) => ({
        ...m,
        status: 'done',
        verifying: false,
        stepsExhausted: exhausted,
        // 计划清单(kind=plan)是按计划文本逐行生成的、没有逐项完成回调,运行收尾即代表计划已执行,
        // 把仍 pending 的计划项收敛为 done,避免清单永远停在「待处理」造成困惑。
        todos: (m.todos || []).map((todo) => (todo.kind === 'plan' && todo.status === 'pending' ? { ...todo, status: 'done' } : todo)),
        text: (full.text || m.text || '') + (exhausted ? '\n\n（任务较大，已完成一部分；点【继续】我接着做完。）' : ''),
        runId: full.runId || m.runId,
        usage: full.usage || m.usage,
      }));
    },

    onCancelled: (full) => {
      setStreamingId(null);
      // 取消即终局:清掉待决审批/计划/提问(host 已吊销,残留按钮点了也只会 404),
      // 在跑工具一并置为已取消,避免界面停在「运行中 + 可点批准」的假活状态。
      patch((m) => ({
        ...m,
        status: 'cancelled',
        verifying: false,
        approval: undefined,
        plan: undefined,
        question: undefined,
        tools: (m.tools || []).map((tool) => (tool.status === 'running' ? { ...tool, status: 'cancelled' } : tool)),
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
