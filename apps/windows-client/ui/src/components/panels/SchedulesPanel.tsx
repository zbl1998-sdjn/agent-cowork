import { useEffect, useState } from 'react';
import { listSchedules, cancelSchedule, type ScheduleItem } from '../../lib/api';
import { Button } from '../ui/Button';
import { Empty, ErrorState } from '../ui/StateViews';

export function SchedulesPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="定时任务加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return <Empty title="还没有定时任务" message="可以对 Kimi 说「每天早上…」。" />;
}

export function SchedulePanelItem({ item, onCancel }: { item: ScheduleItem; onCancel: (id: string) => void }) {
  return (
    <li>
      <code>{item.name}</code>
      <span className="tool-src">{item.status || 'pending'}</span>
      <p>
        {item.cronHuman || item.cron || (item.fireAt ? `一次性 ${item.fireAt}` : '')}
        {item.nextFireAt ? ` · 下次 ${new Date(item.nextFireAt).toLocaleString()}` : ''}
      </p>
      {item.status !== 'cancelled' && (
        <Button onClick={() => onCancel(item.id)}>取消</Button>
      )}
    </li>
  );
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
      <p className="panel-intro">这里能看到 Kimi 帮你安排的所有定时任务。要新建,直接在对话里说<em>「每天早上 8 点把今天的日程发我」</em>「每周一总结一下上周的邮件」这种话即可。</p>
      <div className="panel-row">
        <Button disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</Button>
      </div>
      <ul className="tool-list">
        {items.map((s) => (
          <SchedulePanelItem key={s.id} item={s} onCancel={(id) => void onCancel(id)} />
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
