import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import {
  ConnectorSearchAction,
  ConnectorsPanel,
  ConnectorsPanelMessageState,
  isConnectorErrorMessage,
} from './ConnectorsPanel';

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

describe('ConnectorsPanel state views', () => {
  it('renders the reusable empty state before connector data loads', () => {
    const html = renderToStaticMarkup(<ConnectorsPanel trustedRoot="C:/work" />);

    expect(html).toContain('没有匹配的连接器');
    expect(html).toContain('调整关键词或刷新连接器目录。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
    expect(html).toContain('ui-btn ui-btn--secondary');
  });

  it('renders connector failures with ErrorState', () => {
    const html = renderToStaticMarkup(<ConnectorsPanelMessageState message="连接失败：权限不足" />);

    expect(html).toContain('连接器操作失败');
    expect(html).toContain('权限不足');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('keeps successful connector messages as preformatted output', () => {
    const html = renderToStaticMarkup(<ConnectorsPanelMessageState message="已连接 filesystem（新增 2 个工具）" />);

    expect(html).toContain('panel-result');
    expect(html).toContain('已连接 filesystem');
    expect(html).not.toContain('state-view--error');
  });

  it('classifies only failure-like connector messages as errors', () => {
    expect(isConnectorErrorMessage('错误：目录读取失败')).toBe(true);
    expect(isConnectorErrorMessage('部分失败：filesystem 拒绝')).toBe(true);
    expect(isConnectorErrorMessage('撤销失败：token missing')).toBe(true);
    expect(isConnectorErrorMessage('已授权 GitHub：octo')).toBe(false);
  });

  it('renders connector search with Button primitive and preserves callback', () => {
    const onSearch = vi.fn();
    const html = renderToStaticMarkup(<ConnectorSearchAction onSearch={onSearch} />);
    const buttons = collectByType(ConnectorSearchAction({ onSearch }), Button);

    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('搜索');
    expect(buttons).toHaveLength(1);
    buttons[0].props.onClick();
    expect(onSearch).toHaveBeenCalledOnce();
  });
});
