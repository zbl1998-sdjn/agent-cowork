import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ObservabilityEmptyState,
  ObservabilityErrorState,
  ObservabilityPanel,
} from './ObservabilityPanel';

describe('ObservabilityPanel state views', () => {
  it('renders reusable empty states when there are no run records', () => {
    const html = renderToStaticMarkup(<ObservabilityPanel />);

    expect(html).toContain('暂无运行记录');
    expect(html).toContain('完成一次 agent 运行后会显示在这里。');
    expect(html).toContain('选择一条运行记录查看明细');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders reusable empty states for detail rows', () => {
    const html = renderToStaticMarkup(<ObservabilityEmptyState title="未记录耗时" />);

    expect(html).toContain('未记录耗时');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders load failures with ErrorState and retry affordance', () => {
    const html = renderToStaticMarkup(<ObservabilityErrorState error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('运行记录加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });
});
