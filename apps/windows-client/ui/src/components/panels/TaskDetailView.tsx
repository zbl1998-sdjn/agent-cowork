// Owner-scoped run detail presentation for the task center (UI · components/panels).
import type { RunRecord } from '../../lib/types';
import { taskLiveEventLabel } from '../../lib/task-live';
import type { TaskLiveEvents } from '../../hooks/useTaskLiveEvents';
import { formatDurationMs } from '../../lib/usage-display';
import { Button } from '../ui/Button';
import { ErrorState, Loading } from '../ui/StateViews';

export interface TaskDetailViewProps {
  record: RunRecord | null;
  busy: boolean;
  error: string;
  live?: TaskLiveEvents | null;
  onStop?: (() => void) | undefined;
  onClose: () => void;
}

function LiveSection({ live, onStop }: { live: TaskLiveEvents; onStop?: (() => void) | undefined }) {
  const recent = live.timeline.slice(-8);
  return (
    <section className="task-live" aria-label="实时动态">
      <div className="task-live-head">
        <h4>实时动态{live.finished ? '(已结束)' : ''}</h4>
        {!live.finished && onStop && <Button size="sm" variant="danger" onClick={onStop}>停止任务</Button>}
      </div>
      {live.streamError && <p className="panel-error" role="alert">{live.streamError}</p>}
      {live.pending.map((item) => (
        <div className="approval-bar" key={item.id}>
          <span className="approval-q">等待批准:<code>{item.name}</code>{item.risk && <>(风险 <code>{item.risk}</code>)</>}</span>
          <div className="approval-actions">
            <Button variant="primary" size="sm" disabled={Boolean(live.respondBusy)} onClick={() => live.respond(item.id, 'once')}>
              {live.respondBusy === item.id ? '提交中…' : '批准'}
            </Button>
            <Button variant="danger" size="sm" disabled={Boolean(live.respondBusy)} onClick={() => live.respond(item.id, 'reject')}>拒绝</Button>
          </div>
        </div>
      ))}
      {recent.length > 0 ? (
        <ul className="task-live-timeline">
          {recent.map((event, index) => <li key={`${event.seq ?? index}`}>{taskLiveEventLabel(event)}</li>)}
        </ul>
      ) : (
        <p className="panel-note">暂无事件;进行中的任务会在这里实时滚动。</p>
      )}
    </section>
  );
}

function displayTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN');
}

function errorText(value: RunRecord['error']): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.message || '运行失败';
}

function resultText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  // agent-chat 的 result 是 { ok, text, steps, usage }:优先给用户看回答文本,而不是原始 JSON。
  const record = value as { text?: unknown };
  if (typeof record.text === 'string' && record.text.trim()) return record.text;
  try {
    const text = JSON.stringify(value);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return String(value);
  }
}

export function TaskDetailView({ record, busy, error, live = null, onStop, onClose }: TaskDetailViewProps) {
  const prompt = record?.promptPreview || record?.prompt || record?.input?.prompt || '';
  const rows = record ? [
    ['运行 ID', record.id],
    ['状态', record.status],
    ['类型', record.type],
    ['Provider', record.provider || ''],
    ['模式', record.mode || ''],
    ['开始', displayTime(record.startedAt)],
    ['结束', displayTime(record.finishedAt)],
    ['耗时', typeof record.durationMs === 'number' ? formatDurationMs(record.durationMs) : ''],
  ].filter(([, value]) => Boolean(value)) : [];
  const failure = record ? errorText(record.error) : '';
  const result = record ? resultText(record.result) : '';

  return (
    <aside className="observe-detail" aria-label="任务详情" aria-busy={busy}>
      <div className="observe-head">
        <h3>任务详情</h3>
        <Button size="sm" onClick={onClose}>关闭</Button>
      </div>
      {busy && <Loading message="正在读取任务详情…" />}
      {!busy && error && <ErrorState title="任务详情加载失败" message={error} />}
      {!busy && !error && record && (
        <>
          {prompt && <p>{prompt}</p>}
          <dl className="observe-rows">
            {rows.map(([label, value]) => (
              <div className="observe-row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {failure && <p className="panel-error" role="alert">{failure}</p>}
          {live && <LiveSection live={live} onStop={onStop} />}
          {result && (
            <>
              <h4>运行产出</h4>
              <pre className="tool-output">{result}</pre>
            </>
          )}
          <p className="panel-note">运行记录为已保存快照;实时动态区可跟进进行中任务并直接处理待审批项。</p>
        </>
      )}
    </aside>
  );
}
