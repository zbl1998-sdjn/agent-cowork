import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveArtifactStatusView, LiveArtifactView, liveArtifactViewState } from './LiveArtifactView';

describe('LiveArtifactView state views', () => {
  it('renders the reusable empty state before an artifact exists', () => {
    const html = renderToStaticMarkup(<LiveArtifactView />);

    expect(html).toContain('尚未生成活页');
    expect(html).toContain('渲染完成后会在这里预览。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders the reusable loading state while the first artifact is generating', () => {
    const html = renderToStaticMarkup(
      <LiveArtifactStatusView busy state={liveArtifactViewState({ busy: true })} />,
    );

    expect(html).toContain('正在生成活页');
    expect(html).toContain('state-view--loading');
    expect(html).toContain('aria-busy="true"');
  });

  it('renders refresh failures with ErrorState', () => {
    const html = renderToStaticMarkup(
      <LiveArtifactStatusView state={liveArtifactViewState({ error: '刷新失败' })} />,
    );

    expect(html).toContain('活页刷新失败');
    expect(html).toContain('刷新失败');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });
});
