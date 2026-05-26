import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryPanel, MemoryPanelStateViews } from './MemoryPanel';

describe('MemoryPanel state views', () => {
  it('renders the reusable empty state when there are no memories', () => {
    const html = renderToStaticMarkup(<MemoryPanel trustedRoot="C:/work" />);

    expect(html).toContain('暂无本地画像记忆');
    expect(html).toContain('保存术语、项目和偏好后会显示在这里。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders the reusable error state with retry affordance', () => {
    const html = renderToStaticMarkup(<MemoryPanelStateViews error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('记忆加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });
});
