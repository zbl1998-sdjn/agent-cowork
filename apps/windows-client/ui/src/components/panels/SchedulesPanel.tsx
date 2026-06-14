// 定时任务面板(UI · 组件层 · components/panels)
// ---------------------------------------------------------------------------
// 职责:列出 Kimi 安排的定时任务,展示人话化的下次触发时间与状态,支持刷新与二次确认取消。只渲染+触发回调。
// 依赖:lib/api(listSchedules/cancelSchedule)+ schedule-humanize/friendly-error + ui/Button、ui/StateViews。
import { useEffect, useState } from 'react';
import { listSchedules, cancelSchedule, type ScheduleItem } from '../../lib/api';
import { humanizeError } from '../../lib/friendly-error';
import { humanizeScheduleLine, humanizeScheduleStatus } from '../../lib/schedule-humanize';
import { Button } from '../ui/Button';
import { Empty, ErrorState } from '../ui/StateViews';

export function SchedulesPanelStateViews({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return <ErrorState title="定时任务加载失败" message={error} onRetry={onRetry} retryLabel="重新加载" />;
  }
  return (
    <Empty
      title="还没有定时任务"
      message="可以对 Kimi 说「每天早上 9 点把今天的日程发我」「每周一总结一下上周的邮件」这样的话,它就会帮你安排。"
    />
  );
}

// 每个定时任务一行;名称、状态徽标和时间线都走 humanize-* 辅助函数,
// 让非技术用户看到"每天 09:00 · 下次 今天 09:00 · 运行中",而不是原始 cron/ISO 时间。
export function SchedulePanelItem({ item, onCancel }: { item: ScheduleItem; onCancel: (id: string) => void }) {
  const when = humanizeScheduleLine(item);
  const status = humanizeScheduleStatus(item.status);
  const askCancel = () => {
    // 轻量二次确认:避免误点把用户依赖的长期任务直接删掉。
    const friendlyName = item.name || '这个任务';
    if (window.confirm(`确定要删掉「${friendlyName}」吗?之后想再开,需要重新让 Kimi 安排一次。`)) {
      onCancel(item.id);
    }
  };
  return (
    <li>
      <strong className="schedule-name">{item.name || '未命名任务'}</strong>
      <span className="tool-src">{status}</span>
      {when && <p className="schedule-when">{when}</p>}
      {item.status !== 'cancelled' && (
        <Button onClick={askCancel}>取消</Button>
      )}
    </li>
  );
}

// 列出 Agent 或用户经 host 调度器创建的定时任务,并提供一键取消入口。
export function SchedulesPanel() {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      setItems(await listSchedules());
    } catch (e) {
      setError(humanizeError(e, { action: '读取定时任务' }));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const onCancel = async (id: string) => {
    try {
      await cancelSchedule(id);
      await refresh();
    } catch (e) {
      setError(humanizeError(e, { action: '取消定时任务' }));
    }
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
