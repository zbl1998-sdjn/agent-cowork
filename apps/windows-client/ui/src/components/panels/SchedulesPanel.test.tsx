import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import {
  ScheduleMutationError,
  SchedulePanelItem,
  ScheduleRunReview,
  SchedulesPanel,
  SchedulesPanelStateViews,
} from './SchedulesPanel';

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

    expect(html).toContain('还没有自动任务');
    expect(html).toContain('选择已启用的技能');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('刷新');
  });

  it('renders the reusable error state with retry affordance', () => {
    const html = renderToStaticMarkup(<SchedulesPanelStateViews error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('自动任务加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('labels mutation failures separately from loading failures', () => {
    const html = renderToStaticMarkup(<ScheduleMutationError error="创建失败" />);

    expect(html).toContain('自动任务操作失败');
    expect(html).toContain('创建失败');
    expect(html).not.toContain('自动任务加载失败');
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

  it('shows the latest scheduler failure without mislabelling the recurring task as healthy', () => {
    const html = renderToStaticMarkup(
      <SchedulePanelItem
        item={{
          id: 'schedule-failed',
          name: 'weekly draft',
          cronHuman: '每周一 09:00',
          status: 'pending',
          lastError: 'recipe disabled',
          lastRunId: 'run_failed',
          recipeId: 'weekly-report',
        }}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain('上次生成失败');
    expect(html).toContain('recipe disabled');
    expect(html).toContain('weekly-report');
  });

  it('labels lastRunId as the latest success and exposes retained attempts for read-only review', () => {
    const onReviewRun = vi.fn();
    const item = {
      id: 'schedule-history',
      name: 'weekly draft',
      cronHuman: '每周一 09:00',
      status: 'pending' as const,
      lastRunId: 'run_success',
      attempts: [
        {
          attemptId: 'attempt_success',
          startedAt: '2026-07-12T00:00:00.000Z',
          finishedAt: '2026-07-12T00:00:01.000Z',
          status: 'succeeded' as const,
          runId: 'run_success',
          error: null,
          trigger: 'scheduled' as const,
        },
        {
          attemptId: 'attempt_failure',
          startedAt: '2026-07-12T01:00:00.000Z',
          finishedAt: '2026-07-12T01:00:01.000Z',
          status: 'failed' as const,
          runId: null,
          error: 'recipe disabled',
          trigger: 'scheduled' as const,
        },
      ],
    };
    const tree = SchedulePanelItem({ item, onCancel: () => {}, onReviewRun } as any);
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('最近成功运行');
    expect(html).toContain('运行历史（2）');
    expect(html).toContain('已生成草案');
    expect(html).toContain('执行失败');
    expect(html).toContain('recipe disabled');

    const reviewButton = collectByType(tree, Button).find((button) => button.props.children === '只读复核');
    expect(reviewButton).toBeDefined();
    reviewButton!.props.onClick();
    expect(onReviewRun).toHaveBeenCalledWith('run_success');
  });

  it('renders persisted run details as read-only preview without approval or apply actions', () => {
    const html = renderToStaticMarkup(
      <ScheduleRunReview
        runId="run_success"
        busy={false}
        error=""
        onClose={() => {}}
        run={{
          runId: 'run_success',
          status: 'awaiting_approval',
          result: { text: 'weekly draft ready' },
          events: [
            {
              type: 'preview',
              operations: [{ kind: 'write', path: 'weekly-report.md', content: '# Weekly report' }],
            },
          ],
        } as any}
      />,
    );

    expect(html).toContain('运行结果（只读）');
    expect(html).toContain('等待审批');
    expect(html).toContain('weekly draft ready');
    expect(html).toContain('weekly-report.md');
    expect(html).not.toContain('批准');
    expect(html).not.toContain('应用变更');
  });

  it('describes scheduled work as generating a pending approval draft', () => {
    const html = renderToStaticMarkup(<SchedulesPanel />);

    expect(html).toContain('到点生成待审批草案');
    expect(html).not.toContain('到点执行的动作');
  });

  // 取消操作经过 window.confirm 防误触;默认 node 测试环境没有 window,
  // 因此用 vi.stubGlobal 打桩,不引入 jsdom 依赖。
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
      buttons[0]!.props.onClick();

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
      buttons[0]!.props.onClick();

      expect(confirmFn).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});
