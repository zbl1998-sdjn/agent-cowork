// @ts-check

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
 * @param {RunTraceLike | null | undefined} runTrace
 * @param {number} step
 * @param {unknown[]} messages
 * @param {unknown[]} tools
 */
export function traceModelContext(runTrace, step, messages, tools) {
  appendRunTrace(runTrace, { kind: 'model_context', step, modelSaw: { messages, tools } });
}

/**
 * @param {RunTraceLike | null | undefined} runTrace
 * @param {number} step
 * @param {unknown} modelMessage
 */
export function traceToolDecision(runTrace, step, modelMessage) {
  appendRunTrace(runTrace, { kind: 'tool_decision', step, modelMessage });
}

/**
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
