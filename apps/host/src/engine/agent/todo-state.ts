// Todo 状态模型与生成(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:规范化 todo 条目(id/text/状态),从计划文本切出 todo 列表(去标记/去重/截断),
//      并提供"工具调用 todo 追踪器"——每次工具调用 start→finish 自动发 todo_update 事件。
// 依赖:仅标准库;事件经注入的 emit 广播。
// 导出:createTodoItem / todoItemsFromPlan / createToolTodoTracker
export type TodoStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'rejected';
export type TodoItem = { id: string; text: string; status: TodoStatus; detail?: string; kind?: string };
export type TodoItemInput = { id?: unknown; text?: unknown; status?: unknown; detail?: unknown; kind?: unknown };
export type TodoPlanOptions = { maxItems?: number };
export type TodoEmitter = (type: 'todo_update', payload: TodoItem) => void;
export type ToolTodoHandle = { id: string; finish(status: unknown): void };
export type ToolTodoTracker = { start(name: unknown): ToolTodoHandle };

const VALID_STATUSES = new Set<TodoStatus>(['pending', 'running', 'done', 'failed', 'blocked', 'rejected']);

function normalizeStatus(status: unknown, fallback: TodoStatus = 'pending'): TodoStatus {
  const value = String(status || '').toLowerCase();
  const candidate = value as TodoStatus;
  return VALID_STATUSES.has(candidate) ? candidate : fallback;
}

function normalizeText(text: unknown, fallback: string): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value || fallback;
}

/**
 * 规范化生成一个 todo 条目(缺省值兜底、状态校验、detail 截断 240 字)。
 */
export function createTodoItem({ id, text, status = 'pending', detail, kind }: TodoItemInput = {}): TodoItem {
  return {
    id: normalizeText(id, `todo-${Date.now()}`),
    text: normalizeText(text, '待处理任务'),
    status: normalizeStatus(status),
    ...(detail ? { detail: String(detail).slice(0, 240) } : {}),
    ...(kind ? { kind: String(kind) } : {}),
  };
}

function stripPlanMarker(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*|\[[ xX]\]\s*)/, '')
    .replace(/^#+\s*/, '')
    .trim();
}

/**
 * 从计划文本逐行解析出 todo 列表:剥离列表/标题标记、去引号、去重并截断到 maxItems。
 */
export function todoItemsFromPlan(planText: unknown, { maxItems = 8 }: TodoPlanOptions = {}): TodoItem[] {
  const seen = new Set<string>();
  return String(planText || '')
    .split(/\r?\n/)
    .map(stripPlanMarker)
    .map((line) => line.replace(/^["'`]+|["'`]+$/g, '').trim())
    .filter((line) => line.length >= 2)
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, maxItems))
    .map((text, index) => createTodoItem({ id: `plan-${index + 1}`, text, status: 'pending', kind: 'plan' }));
}

/**
 * 创建工具调用 todo 追踪器:start 时发 running 条目,返回 finish 句柄按成败更新状态。
 */
export function createToolTodoTracker(emit: TodoEmitter = () => undefined): ToolTodoTracker {
  let sequence = 0;
  return {
    start(name) {
      sequence += 1;
      const toolName = normalizeText(name, '工具');
      const item = createTodoItem({
        id: `tool-${sequence}-${toolName}`,
        text: `调用 ${toolName}`,
        status: 'running',
        kind: 'tool',
      });
      emit('todo_update', item);
      return {
        id: item.id,
        finish(status: unknown) {
          const nextStatus = normalizeStatus(status, status === 'succeeded' ? 'done' : 'failed');
          emit('todo_update', { ...item, status: nextStatus });
        },
      };
    },
  };
}
