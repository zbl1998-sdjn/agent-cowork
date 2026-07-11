import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskPanelItem, TasksPanel, TasksPanelStateViews } from './TasksPanel';

describe('TasksPanel', () => {
  it('renders an actionable empty state without implying that no run has ever existed', () => {
    const html = renderToStaticMarkup(<TasksPanel />);

    expect(html).toContain('还没有可复核的任务');
    expect(html).toContain('刷新');
    expect(html).toContain('state-view--empty');
  });

  it('keeps waiting approval and failure details visible for review', () => {
    const waiting = renderToStaticMarkup(<TaskPanelItem item={{
      id: 'run_waiting',
      status: 'awaiting_approval',
      activeForm: '等待审批',
      prompt: '整理合同差异',
      startedAt: '2026-07-12T00:00:00.000Z',
    }} />);
    const failed = renderToStaticMarkup(<TaskPanelItem item={{
      id: 'run_failed',
      status: 'failed',
      activeForm: '需要查看错误',
      prompt: '生成周报',
      error: '模型服务不可用',
    }} />);

    expect(waiting).toContain('等待审批');
    expect(waiting).toContain('整理合同差异');
    expect(failed).toContain('模型服务不可用');
    expect(failed).toContain('badge-failed');
  });

  it('renders load failures with an explicit retry path', () => {
    const html = renderToStaticMarkup(<TasksPanelStateViews error="Host 暂不可达" onRetry={() => {}} />);

    expect(html).toContain('任务加载失败');
    expect(html).toContain('Host 暂不可达');
    expect(html).toContain('重新加载');
    expect(html).toContain('role="alert"');
  });
});
