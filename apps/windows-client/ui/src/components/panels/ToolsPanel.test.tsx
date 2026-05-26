import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolsPanel, ToolsPanelResultState, isToolPanelErrorResult } from './ToolsPanel';

describe('ToolsPanel state views', () => {
  it('renders the reusable empty state before a search', () => {
    const html = renderToStaticMarkup(<ToolsPanel trustedRoot="C:/work" />);

    expect(html).toContain('输入关键字搜索工具');
    expect(html).toContain('匹配到的可用工具会显示在这里。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders tool errors with ErrorState', () => {
    const html = renderToStaticMarkup(<ToolsPanelResultState result="错误：工具不存在" />);

    expect(html).toContain('工具调用失败');
    expect(html).toContain('工具不存在');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('keeps successful tool results as preformatted output', () => {
    const html = renderToStaticMarkup(<ToolsPanelResultState result={'{\n  "ok": true\n}'} />);

    expect(html).toContain('panel-result');
    expect(html).toContain('&quot;ok&quot;');
    expect(html).not.toContain('state-view--error');
  });

  it('classifies only failure-like result strings as errors', () => {
    expect(isToolPanelErrorResult('错误：失败')).toBe(true);
    expect(isToolPanelErrorResult('参数 JSON 无效：Unexpected token')).toBe(true);
    expect(isToolPanelErrorResult('{"错误":"只是结果字段"}')).toBe(false);
  });
});
