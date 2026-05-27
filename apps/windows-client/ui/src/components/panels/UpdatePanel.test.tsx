import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import { UpdatePanelView } from './UpdatePanel';

describe('UpdatePanelView', () => {
  it('renders no-update state and keeps the check button wired', () => {
    const onCheck = vi.fn();
    const html = renderToStaticMarkup(
      <UpdatePanelView
        desktop
        status="ready"
        update={{ available: false, currentVersion: '0.2.0' }}
        error=""
        onCheck={onCheck}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain('桌面更新');
    expect(html).toContain('当前已是最新版本');
    expect(html).toContain('0.2.0');
    expect(html).toContain('ui-btn ui-btn--secondary');
  });

  it('renders install action only when an update is available', () => {
    const html = renderToStaticMarkup(
      <UpdatePanelView
        desktop
        status="ready"
        update={{ available: true, currentVersion: '0.2.0', version: '0.3.0', body: 'signed update' }}
        error=""
        onCheck={vi.fn()}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain('发现 0.3.0');
    expect(html).toContain('signed update');
    expect(html).toContain('下载并安装');
  });

  it('uses Button primitives and blocks non-desktop checks', () => {
    const buttons = [
      ...collectByType(UpdatePanelView({
        desktop: false,
        status: 'idle',
        update: null,
        error: '',
        onCheck: vi.fn(),
        onInstall: vi.fn(),
      }), Button),
    ];

    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.disabled).toBe(true);
  });
});

function collectByType(node: any, type: unknown): any[] {
  if (!node || typeof node !== 'object') return [];
  const children = node.props?.children;
  const current = node.type === type ? [node] : [];
  const nested = Array.isArray(children) ? children.flatMap((child) => collectByType(child, type)) : collectByType(children, type);
  return [...current, ...nested];
}
