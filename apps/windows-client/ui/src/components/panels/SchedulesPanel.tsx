import { useEffect, useState } from 'react';
import { listSchedules, cancelSchedule, type ScheduleItem } from '../../lib/api';
import { Empty, ErrorState } from '../ui/StateViews';

export function SchedulesPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="定时任务加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return <Empty title="还没有定时任务" message="可以对 Kimi 说「每天早上…」。" />;
}

// Lists scheduled tasks the agent (or user) created via the host scheduler, with
// one-click cancel. Mirrors Claude Cowork's "schedule this each morning" surface.
export function SchedulesPanel() {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try { setItems(await listSchedules()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const onCancel = async (id: string) => {
    await cancelSchedule(id);
    await refresh();
  };

  return (
    <section className="side-panel">
      <h2>定时任务</h2>
      <div className="panel-row">
        <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
      </div>
      <ul className="tool-list">
        {items.map((s) => (
          <li key={s.id}>
            <code>{s.name}</code>
            <span className="tool-src">{s.status || 'pending'}</span>
            <p>{s.cronHuman || s.cron || (s.fireAt ? `一次性 ${s.fireAt}` : '')}{s.nextFireAt ? ` · 下次 ${new Date(s.nextFireAt).toLocaleString()}` : ''}</p>
            {s.status !== 'cancelled' && (
              <button type="button" onClick={() => void onCancel(s.id)}>取消</button>
            )}
          </li>
        ))}
        {items.length === 0 && !error && (
          <li className="panel-empty">
            <SchedulesPanelStateViews error="" onRetry={() => void refresh()} />
          </li>
        )}
      </ul>
      {error && <SchedulesPanelStateViews error={error} onRetry={() => void refresh()} />}
    </section>
  );
}
