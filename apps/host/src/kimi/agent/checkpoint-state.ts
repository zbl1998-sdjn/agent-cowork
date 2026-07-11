// 运行检查点记录器:可恢复地保存 Agent 运行进度(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:在 Agent 循环各阶段把当前 messages/usage/已批准工具/todos/步骤等快照交给
//      checkpointer 持久化,供中断后续跑;同时维护一份内存 todos 镜像(按 id 去重更新)。
// 依赖:仅标准库;持久化由注入的 checkpointer 完成,事件由注入的 emit 广播。
// 导出:createCheckpointRecorder(返回 { emitTodo, save })
export type TodoPayload = { id?: unknown };
export type Checkpointer = { save(input: Record<string, unknown>): string };
export type CheckpointRecorderOptions = {
  checkpointer?: Checkpointer | null;
  runId?: string | null;
  usageTotals: unknown;
  sessionApproved: Set<unknown>;
  steps: unknown[];
  context?: unknown;
  initialTodos?: unknown;
  getFinalText: () => string;
  emit: (type: string, payload: unknown) => void;
};
export type CheckpointRecorder = {
  emitTodo(type: string, payload: unknown): void;
  save(phase: string, step: number, messages: unknown): boolean;
};

function recordTodo(todos: unknown[], payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const item = payload as TodoPayload;
  const id = String(item.id || '');
  if (!id) return;
  const index = todos.findIndex((todo) => (
    !!todo && typeof todo === 'object' && String((todo as TodoPayload).id || '') === id
  ));
  if (index >= 0) todos[index] = payload;
  else todos.push(payload);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 创建检查点记录器:emitTodo 在广播 todo 的同时同步内存镜像,save 把当前进度落盘。
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
}: CheckpointRecorderOptions): CheckpointRecorder {
  const todos: unknown[] = Array.isArray(initialTodos) ? JSON.parse(JSON.stringify(initialTodos)) as unknown[] : [];
  return {
    emitTodo(type: string, payload: unknown) {
      if (type === 'todo_update') recordTodo(todos, payload);
      emit(type, payload);
    },
    save(phase: string, step: number, messages: unknown): boolean {
      if (!checkpointer || !runId) return false;
      try {
        checkpointer.save({
          runId,
          owner: context,
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
