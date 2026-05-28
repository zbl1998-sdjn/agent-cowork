import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import { SchedulePanelItem, SchedulesPanel, SchedulesPanelStateViews } from './SchedulesPanel';

function collectByType(node: ReactNode, type: unknown): ReactElement<Record<string, any>>[] {
  const matches: ReactElement<Record<string, any>>[] = [];
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === type) {
        matches.push(child as ReactElement<Record<string, any>>);
      }
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(node);
  return matches;
}

describe('SchedulesPanel state views', () => {
  it('renders the reusable empty state when there are no schedules', () => {
    const html = renderToStaticMarkup(<SchedulesPanel />);

    expect(html).toContain('还没有定时任务');
    expect(html).toContain('可以对 Kimi 说');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('刷新');
  });

  it('renders the reusable error state with retry affordance', () => {
    const html = renderToStaticMarkup(<SchedulesPanelStateViews error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('定时任务加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('renders schedule cancel action with the Button primitive', () => {
    const html = renderToStaticMarkup(
      <SchedulePanelItem
        item={{ id: 'schedule-1', name: 'daily summary', cronHuman: '每天 09:00', status: 'active' }}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('取消');
  });

  // The white-collar copy wraps cancellation in window.confirm so a misclick
  // doesn't silently delete a daily briefing. Tests run in the default node env
  // where `window` is undefined, so stub it via vi.stubGlobal (no jsdom dep).
  function withConfirm<T>(result: boolean, run: (confirmFn: ReturnType<typeof vi.fn>) => T): T {
    const confirmFn = vi.fn(() => result);
    vi.stubGlobal('window', { confirm: confirmFn });
    try {
      return run(confirmFn);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('keeps schedule cancellation wired to the item id (after user confirms)', () => {
    withConfirm(true, (confirmFn) => {
      const onCancel = vi.fn();
      const buttons = collectByType(
        SchedulePanelItem({
          item: { id: 'schedule-1', name: 'daily summary', cronHuman: '每天 09:00', status: 'active' },
          onCancel,
        }),
        Button,
      );

      expect(buttons).toHaveLength(1);
      buttons[0].props.onClick();

      expect(confirmFn).toHaveBeenCalledOnce();
      expect(onCancel).toHaveBeenCalledOnce();
      expect(onCancel).toHaveBeenCalledWith('schedule-1');
    });
  });

  it('skips cancellation when user declines the confirm', () => {
    withConfirm(false, (confirmFn) => {
      const onCancel = vi.fn();
      const buttons = collectByType(
        SchedulePanelItem({
          item: { id: 'schedule-1', name: 'daily summary', cronHuman: '每天 09:00', status: 'active' },
          onCancel,
        }),
        Button,
      );
      buttons[0].props.onClick();

      expect(confirmFn).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});
