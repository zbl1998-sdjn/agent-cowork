// @ts-check

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
 * @param {CheckpointRecorderOptions} options
 */
export function createCheckpointRecorder({
  checkpointer,
  runId,
  usageTotals,
  sessionApproved,
  steps,
  context,
  getFinalText,
  emit,
}) {
  /** @type {unknown[]} */
  const todos = [];
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
