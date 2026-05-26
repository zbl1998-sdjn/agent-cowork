import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import {
  ConnectorBuiltinAction,
  ConnectorOAuthAction,
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

  it('keeps OAuth action labels, disabled state, and branch callbacks', () => {
    const onApprove = vi.fn();
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const onRevoke = vi.fn();
    const missingHtml = renderToStaticMarkup(
      <ConnectorOAuthAction
        busy={false}
        connected={false}
        hasSession={false}
        approved={false}
        missingConfig
        onApprove={onApprove}
        onStart={onStart}
        onComplete={onComplete}
        onRevoke={onRevoke}
      />,
    );
    const approvedButton = collectByType(
      ConnectorOAuthAction({
        busy: false,
        connected: false,
        hasSession: false,
        approved: true,
        missingConfig: false,
        onApprove,
        onStart,
        onComplete,
        onRevoke,
      }),
      Button,
    )[0];
    const completeButton = collectByType(
      ConnectorOAuthAction({
        busy: false,
        connected: false,
        hasSession: true,
        approved: false,
        missingConfig: false,
        onApprove,
        onStart,
        onComplete,
        onRevoke,
      }),
      Button,
    )[0];
    const revokeButton = collectByType(
      ConnectorOAuthAction({
        busy: false,
        connected: true,
        hasSession: false,
        approved: false,
        missingConfig: false,
        onApprove,
        onStart,
        onComplete,
        onRevoke,
      }),
      Button,
    )[0];

    expect(missingHtml).toContain('ui-btn ui-btn--secondary');
    expect(missingHtml).toContain('待配置 OAuth');
    expect(missingHtml).toContain('disabled=""');
    approvedButton.props.onClick();
    completeButton.props.onClick();
    revokeButton.props.onClick();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onRevoke).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('keeps builtin connect action labels and callbacks', () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const busyHtml = renderToStaticMarkup(
      <ConnectorBuiltinAction busy connected={false} onConnect={onConnect} onDisconnect={onDisconnect} />,
    );
    const connectButton = collectByType(
      ConnectorBuiltinAction({ busy: false, connected: false, onConnect, onDisconnect }),
      Button,
    )[0];
    const disconnectButton = collectByType(
      ConnectorBuiltinAction({ busy: false, connected: true, onConnect, onDisconnect }),
      Button,
    )[0];

    expect(busyHtml).toContain('ui-btn ui-btn--secondary');
    expect(busyHtml).toContain('连接中…');
    expect(busyHtml).toContain('disabled=""');
    connectButton.props.onClick();
    disconnectButton.props.onClick();
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});
