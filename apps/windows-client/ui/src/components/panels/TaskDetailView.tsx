// Owner-scoped run detail presentation for the task center (UI · components/panels).
import type { RunRecord } from '../../lib/types';
import { formatDurationMs } from '../../lib/usage-display';
import { Button } from '../ui/Button';
import { ErrorState, Loading } from '../ui/StateViews';

export interface TaskDetailViewProps {
  record: RunRecord | null;
  busy: boolean;
  error: string;
  onClose: () => void;
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
  try {
    const text = JSON.stringify(value);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return String(value);
  }
}

export function TaskDetailView({ record, busy, error, onClose }: TaskDetailViewProps) {
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
          {result && (
            <>
              <h4>运行产出</h4>
              <pre className="tool-output">{result}</pre>
            </>
          )}
          <p className="panel-note">此处仅复核已保存的运行记录，不会重放任务或执行操作。</p>
        </>
      )}
    </aside>
  );
}
