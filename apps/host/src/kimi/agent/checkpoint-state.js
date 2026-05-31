// @ts-check
// 运行检查点记录器:可恢复地保存 Agent 运行进度(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:在 Agent 循环各阶段把当前 messages/usage/已批准工具/todos/步骤等快照交给
//      checkpointer 持久化,供中断后续跑;同时维护一份内存 todos 镜像(按 id 去重更新)。
// 依赖:仅标准库;持久化由注入的 checkpointer 完成,事件由注入的 emit 广播。
// 导出:createCheckpointRecorder(返回 { emitTodo, save })
/**
 * @typedef {{ id?: unknown }} TodoPayload
 * @typedef {{ save(input: Record<string, unknown>): string }} Checkpointer
 * @typedef {{
 *   checkpointer?: Checkpointer | null,
 *   runId?: string | null,
 *   usageTotals: unknown,
 *   sessionApproved: Set<unknown>,
 *   steps: unknown[],
 *   context?: unknown,
 *   initialTodos?: unknown,
 *   getFinalText: () => string,
 *   emit: (type: string, payload: unknown) => void,
 * }} CheckpointRecorderOptions
 */

/**
 * @param {unknown[]} todos
 * @param {unknown} payload
 */
function recordTodo(todos, payload) {
  if (!payload || typeof payload !== 'object') return;
  const item = /** @type {TodoPayload} */ (payload);
  const id = String(item.id || '');
  if (!id) return;
  const index = todos.findIndex((todo) => (
    !!todo && typeof todo === 'object' && String(/** @type {TodoPayload} */ (todo).id || '') === id
  ));
  if (index >= 0) todos[index] = payload;
  else todos.push(payload);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 创建检查点记录器:emitTodo 在广播 todo 的同时同步内存镜像,save 把当前进度落盘。
 * @param {CheckpointRecorderOptions} options
 */
export function createCheckpointRecorder({
  checkpointer,
  runId,
  usageTotals,
  sessionApproved,
  steps,
  context,
  initialTodos,
  getFinalText,
  emit,
}) {
  /** @type {unknown[]} */
  const todos = Array.isArray(initialTodos) ? /** @type {unknown[]} */ (JSON.parse(JSON.stringify(initialTodos))) : [];
  return {
    /** @param {string} type @param {unknown} payload */
    emitTodo(type, payload) {
      if (type === 'todo_update') recordTodo(todos, payload);
      emit(type, payload);
    },
    /** @param {string} phase @param {number} step @param {unknown} messages @returns {boolean} */
    save(phase, step, messages) {
      if (!checkpointer || !runId) return false;
      try {
        checkpointer.save({
          runId,
          step,
          phase,
          messages,
          usage: usageTotals,
          approvedTools: sessionApproved,
          todos,
          metadata: { context, steps, finalText: getFinalText() },
        });
        emit('run_checkpoint_saved', { runId, step, phase });
        return true;
      } catch (err) {
        emit('run_checkpoint_error', { runId, step, phase, error: errorMessage(err) });
        return false;
      }
    },
  };
}
