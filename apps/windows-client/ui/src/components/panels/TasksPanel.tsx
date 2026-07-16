// 任务中心(UI · components/panels):复核 Host 任务记录,支持搜索、状态筛选和显式刷新;
// 选中任务后 attach 其 run 事件流(回放+实时),待审批项可直接在详情卡上批准/拒绝,进行中任务可停止。
import { cancelRun } from '../../lib/api';
import { useTaskLiveEvents } from '../../hooks/useTaskLiveEvents';
import { useTasksPanel, type TaskFilter } from '../../hooks/useTasksPanel';
import type { TaskSummary } from '../../lib/types/tasks';
import { formatDurationMs } from '../../lib/usage-display';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { TaskDetailView } from './TaskDetailView';
import { Button } from '../ui/Button';
import { Empty, ErrorState } from '../ui/StateViews';

function formatTaskTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TasksPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="任务加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return (
    <Empty
      title="还没有可复核的任务"
      message="完成一次对话、技能或沙箱运行后，可在这里回看状态与结果。"
      action={<Button onClick={onRetry}>刷新</Button>}
    />
  );
}

export function TaskPanelItem({
  item,
  selected = false,
  onSelect,
}: {
  item: TaskSummary;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const title = item.prompt || item.summary || item.type || '未命名任务';
  const details = [item.type, item.provider, item.mode].filter(Boolean).join(' · ');
  const startedAt = formatTaskTime(item.startedAt);
  const duration = typeof item.durationMs === 'number' ? formatDurationMs(item.durationMs) : '';

  return (
    <li>
      <TaskStatusBadge runId={item.id} status={item.status} activeForm={item.activeForm} />
      <strong className="schedule-name">{title}</strong>
      {item.summary && item.summary !== title && <p>{item.summary}</p>}
      {item.error && <p className="panel-error" role="alert">{item.error}</p>}
      {details && <p>{details}</p>}
      {(startedAt || duration) && <p>{[startedAt, duration].filter(Boolean).join(' · ')}</p>}
      <p><code>{item.id}</code></p>
      {onSelect && (
        <Button size="sm" variant={selected ? 'primary' : 'secondary'} onClick={() => onSelect(item.id)}>
          {selected ? '正在查看' : '查看详情'}
        </Button>
      )}
    </li>
  );
}

export function TasksPanel() {
  const state = useTasksPanel();
  const live = useTaskLiveEvents(state.selectedId);

  return (
    <section className="side-panel">
      <h2>任务中心</h2>
      <p className="panel-intro">集中跟进最近任务：进行中的任务可实时查看动态、直接批准或停止；历史任务可回看结果与失败原因。</p>
      <div className="panel-row">
        <input
          aria-label="搜索任务"
          placeholder="搜索任务、运行 ID、模型…"
          value={state.query}
          onChange={(event) => state.setQuery(event.target.value)}
        />
        <Button disabled={state.busy} onClick={() => void state.refresh()}>
          {state.busy ? '刷新中…' : '刷新'}
        </Button>
      </div>
      <div className="panel-row">
        <label>
          状态：{' '}
          <select
            aria-label="筛选任务状态"
            value={state.filter}
            onChange={(event) => state.setFilter(event.target.value as TaskFilter)}
          >
            <option value="all">全部</option>
            <option value="attention">待复核</option>
            <option value="in_progress">进行中</option>
            <option value="done">已完成</option>
          </select>
        </label>
        <span className="tool-src">共 {state.items.length} 项 · 待复核 {state.attentionCount} 项</span>
      </div>
      <ul className="tool-list">
        {state.visibleItems.map((item) => (
          <TaskPanelItem
            key={item.id}
            item={item}
            selected={state.selectedId === item.id}
            onSelect={state.selectTask}
          />
        ))}
        {state.visibleItems.length === 0 && !state.loadError && (
          <li className="panel-empty">
            {state.items.length === 0 ? (
              <TasksPanelStateViews error="" onRetry={() => void state.refresh()} />
            ) : (
              <Empty title="没有匹配的任务" message="调整搜索词或状态筛选后再试。" />
            )}
          </li>
        )}
      </ul>
      {state.selectedId && (
        <TaskDetailView
          record={state.selected}
          busy={state.detailBusy}
          error={state.detailError}
          live={live}
          onStop={() => { if (state.selectedId) void cancelRun(state.selectedId); }}
          onClose={state.closeTaskDetail}
        />
      )}
      {state.loadError && <TasksPanelStateViews error={state.loadError} onRetry={() => void state.refresh()} />}
    </section>
  );
}
