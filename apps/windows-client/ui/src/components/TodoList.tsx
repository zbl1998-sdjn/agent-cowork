import type { TodoItem } from '../lib/types';

const STATUS_LABELS: Record<TodoItem['status'], string> = {
  pending: '待处理',
  running: '进行中',
  done: '完成',
  failed: '失败',
  blocked: '已阻止',
  rejected: '已拒绝',
};

export function TodoList({ items }: { items: TodoItem[] }) {
  if (!items.length) return null;
  return (
    <section className="todo-list" aria-label="执行清单">
      <div className="todo-list-head">执行清单</div>
      <ol className="todo-list-items">
        {items.map((item) => (
          <li key={item.id} className={`todo-item is-${item.status}`}>
            <span className="todo-item-text">{item.text}</span>
            <span className="todo-item-status">{STATUS_LABELS[item.status]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
