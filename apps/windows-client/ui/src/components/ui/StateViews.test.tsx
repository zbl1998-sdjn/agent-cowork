import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Empty, ErrorState, Loading } from './StateViews';

describe('StateViews', () => {
  it('Empty renders title and message with status role', () => {
    const html = renderToStaticMarkup(<Empty title="没有对话" message="开始一个新对话吧" />);
    expect(html).toContain('没有对话');
    expect(html).toContain('开始一个新对话吧');
    expect(html).toContain('role="status"');
  });

  it('Empty falls back to a default title', () => {
    const html = renderToStaticMarkup(<Empty />);
    expect(html).toContain('暂无内容');
  });

  it('Loading shows a busy state and message', () => {
    const html = renderToStaticMarkup(<Loading message="正在加载工具" />);
    expect(html).toContain('正在加载工具');
    expect(html).toContain('aria-busy="true"');
  });

  it('ErrorState shows message and a retry button when onRetry is given', () => {
    const html = renderToStaticMarkup(
      <ErrorState message="网络错误" onRetry={() => {}} retryLabel="再试一次" />,
    );
    expect(html).toContain('网络错误');
    expect(html).toContain('再试一次');
    expect(html).toContain('ui-btn ui-btn--secondary ui-btn--sm state-view__retry');
    expect(html).toContain('role="alert"');
  });

  it('ErrorState omits the retry button without onRetry', () => {
    const html = renderToStaticMarkup(<ErrorState message="只读错误" />);
    expect(html).toContain('只读错误');
    expect(html).not.toContain('<button');
  });
});
