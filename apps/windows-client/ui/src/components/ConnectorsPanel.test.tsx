import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ConnectorsPanel,
  ConnectorsPanelMessageState,
  isConnectorErrorMessage,
} from './ConnectorsPanel';

describe('ConnectorsPanel state views', () => {
  it('renders the reusable empty state before connector data loads', () => {
    const html = renderToStaticMarkup(<ConnectorsPanel trustedRoot="C:/work" />);

    expect(html).toContain('没有匹配的连接器');
    expect(html).toContain('调整关键词或刷新连接器目录。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
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
});
