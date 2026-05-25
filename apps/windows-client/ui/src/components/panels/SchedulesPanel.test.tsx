import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SchedulesPanel, SchedulesPanelStateViews } from './SchedulesPanel';

describe('SchedulesPanel state views', () => {
  it('renders the reusable empty state when there are no schedules', () => {
    const html = renderToStaticMarkup(<SchedulesPanel />);

    expect(html).toContain('还没有定时任务');
    expect(html).toContain('可以对 Kimi 说');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders the reusable error state with retry affordance', () => {
    const html = renderToStaticMarkup(<SchedulesPanelStateViews error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('定时任务加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });
});
