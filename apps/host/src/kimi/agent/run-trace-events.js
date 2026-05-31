// @ts-check
// 运行 trace 事件追加器(诊断用)(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:把每步的"模型看到的上下文 / 工具决策 / 工具结果"追加进 runTrace,供事后回放调试;
//      追加失败一律吞掉——trace 仅诊断,绝不打断 Agent 循环。
// 依赖:仅标准库;runTrace 由调用方注入(可为空)。
// 导出:traceModelContext / traceToolDecision / traceToolResult
/**
 * @typedef {{ append(event: Record<string, unknown>): unknown }} RunTraceLike
 * @typedef {{ id?: unknown }} ToolCallLike
 */

/**
 * @param {RunTraceLike | null | undefined} runTrace
 * @param {Record<string, unknown>} event
 */
function appendRunTrace(runTrace, event) {
  if (!runTrace || typeof runTrace.append !== 'function') return;
  try {
    runTrace.append(event);
  } catch {
    // Trace collection is diagnostic only; never break the agent loop.
  }
}

/**
 * 记录本步喂给模型的上下文(messages 与 tools)。
 * @param {RunTraceLike | null | undefined} runTrace
 * @param {number} step
 * @param {unknown[]} messages
 * @param {unknown[]} tools
 */
export function traceModelContext(runTrace, step, messages, tools) {
  appendRunTrace(runTrace, { kind: 'model_context', step, modelSaw: { messages, tools } });
}

/**
 * 记录本步模型给出的工具决策(原始 assistant 消息)。
 * @param {RunTraceLike | null | undefined} runTrace
 * @param {number} step
 * @param {unknown} modelMessage
 */
export function traceToolDecision(runTrace, step, modelMessage) {
  appendRunTrace(runTrace, { kind: 'tool_decision', step, modelMessage });
}

/**
 * 记录某次工具调用的执行结果(调用 id、工具名、状态与结果)。
 * @param {RunTraceLike | null | undefined} runTrace
 * @param {number} step
 * @param {ToolCallLike | null | undefined} call
 * @param {string | undefined} tool
 * @param {string} status
 * @param {unknown} result
 */
export function traceToolResult(runTrace, step, call, tool, status, result) {
  appendRunTrace(runTrace, { kind: 'tool_result', step, callId: call && call.id, tool, status, result });
}
