// 运行 trace 事件追加器(诊断用)(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:把每步的"模型看到的上下文 / 工具决策 / 工具结果"追加进 runTrace,供事后回放调试;
//      追加失败一律吞掉——trace 仅诊断,绝不打断 Agent 循环。
// 依赖:仅标准库;runTrace 由调用方注入(可为空)。
// 导出:traceModelContext / traceToolDecision / traceToolResult
export type RunTraceLike = { append(event: Record<string, unknown>): unknown };
export type ToolCallLike = { id?: unknown };

function appendRunTrace(runTrace: RunTraceLike | null | undefined, event: Record<string, unknown>): void {
  if (!runTrace || typeof runTrace.append !== 'function') return;
  try {
    runTrace.append(event);
  } catch {
    // Trace collection is diagnostic only; never break the agent loop.
  }
}

/**
 * 记录本步喂给模型的上下文(messages 与 tools)。
 */
export function traceModelContext(runTrace: RunTraceLike | null | undefined, step: number, messages: unknown[], tools: unknown[]): void {
  appendRunTrace(runTrace, { kind: 'model_context', step, modelSaw: { messages, tools } });
}

/**
 * 记录本步模型给出的工具决策(原始 assistant 消息)。
 */
export function traceToolDecision(runTrace: RunTraceLike | null | undefined, step: number, modelMessage: unknown): void {
  appendRunTrace(runTrace, { kind: 'tool_decision', step, modelMessage });
}

/**
 * 记录某次工具调用的执行结果(调用 id、工具名、状态与结果)。
 */
export function traceToolResult(
  runTrace: RunTraceLike | null | undefined,
  step: number,
  call: ToolCallLike | null | undefined,
  tool: string | undefined,
  status: string,
  result: unknown,
): void {
  appendRunTrace(runTrace, { kind: 'tool_result', step, callId: call && call.id, tool, status, result });
}
