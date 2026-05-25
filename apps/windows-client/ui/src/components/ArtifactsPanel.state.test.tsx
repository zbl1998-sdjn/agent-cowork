import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactsPanel, ArtifactsPanelStateViews } from './ArtifactsPanel';

describe('ArtifactsPanel state views', () => {
  it('renders the reusable empty state when there are no artifacts', () => {
    const html = renderToStaticMarkup(<ArtifactsPanel trustedRoot="C:/work" />);

    expect(html).toContain('还没有产物');
    expect(html).toContain('完成一次任务后会出现在这里。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders the reusable error state with retry affordance', () => {
    const html = renderToStaticMarkup(<ArtifactsPanelStateViews error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('产物加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });
});
