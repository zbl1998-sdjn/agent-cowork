import type { SubtaskGroupItem } from '../lib/types';

const STATUS_LABELS: Record<SubtaskGroupItem['status'], string> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
};

export function SubtaskGroups({ items }: { items: SubtaskGroupItem[] }) {
  if (!items.length) return null;
  return (
    <section className="subtask-groups" aria-label="子任务分组">
      <div className="subtask-groups-head">子任务分组</div>
      <ol className="subtask-groups-items">
        {items.map((item) => (
          <li key={item.index} className={`subtask-item is-${item.status}`}>
            <span className="subtask-index">{item.index + 1}</span>
            <span className="subtask-goal">{item.goal}</span>
            <span className="subtask-status">{STATUS_LABELS[item.status]}</span>
            <span className="subtask-meta">
              {typeof item.stepCount === 'number' ? `${item.stepCount} 步` : ''}
              {item.runId ? <code>{item.runId.slice(0, 14)}</code> : null}
              {item.error ? <em>{item.error}</em> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
