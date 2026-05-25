import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary>
        <span>正常内容</span>
      </ErrorBoundary>,
    );
    expect(html).toContain('正常内容');
  });

  it('getDerivedStateFromError captures the error into state', () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error?.message).toBe('boom');
  });

  it('renders a labelled, retryable fallback with the error message when errored', () => {
    const boundary = new ErrorBoundary({ label: '工具面板', children: null });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('加载失败'));
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain('工具面板 出错了');
    expect(html).toContain('加载失败');
    expect(html).toContain('重试');
  });

  it('uses a custom fallback when one is provided', () => {
    const boundary = new ErrorBoundary({
      children: null,
      fallback: (error) => <div>自定义:{error.message}</div>,
    });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('x'));
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain('自定义:x');
  });
});
