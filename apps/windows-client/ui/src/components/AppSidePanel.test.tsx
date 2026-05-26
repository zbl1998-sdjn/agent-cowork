import { Children, Suspense, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppSidePanel } from './AppSidePanel';
import { ErrorBoundary } from './ui/ErrorBoundary';

function renderPanel(panel: Parameters<typeof AppSidePanel>[0]['panel'] = 'tools') {
  return AppSidePanel({
    panel,
    trustedRoot: 'C:/work',
    onClose: vi.fn(),
    onRunSubagent: vi.fn(),
  }) as ReactElement | null;
}

describe('AppSidePanel', () => {
  it('renders nothing when no panel is active', () => {
    expect(renderPanel('none')).toBeNull();
  });

  it('wraps the active panel in a labelled error boundary', () => {
    const element = renderPanel('tools');
    expect(element).not.toBeNull();

    const props = element?.props as { children: unknown };
    const children = Children.toArray(props.children as ReactNode);
    const boundary = children.find(
      (child) => isValidElement(child) && child.type === ErrorBoundary,
    ) as ReactElement | undefined;

    expect(boundary).toBeTruthy();
    expect(String(boundary?.key)).toContain('tools');
    expect((boundary?.props as { label?: string }).label).toBe('工具面板');
  });

  it('renders lazy panel fallback while the selected panel chunk loads', () => {
    const html = renderToStaticMarkup(
      <AppSidePanel panel="schedules" trustedRoot="C:/work" onClose={vi.fn()} onRunSubagent={vi.fn()} />,
    );
    expect(html).toContain('正在加载面板');
    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain('ui-icon-btn drawer-close');
  });

  it('loads panel content behind suspense', () => {
    const element = renderPanel('tools');
    const props = element?.props as { children: unknown };
    const children = Children.toArray(props.children as ReactNode);
    const boundary = children.find(
      (child) => isValidElement(child) && child.type === ErrorBoundary,
    ) as ReactElement | undefined;
    const suspense = (boundary?.props as { children?: ReactElement }).children;

    expect(suspense?.type).toBe(Suspense);
  });
});
