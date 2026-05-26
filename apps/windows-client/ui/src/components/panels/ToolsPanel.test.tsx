import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import {
  ToolsPanel,
  ToolsPanelCallActions,
  ToolsPanelPlanActions,
  ToolsPanelResultState,
  isToolPanelErrorResult,
} from './ToolsPanel';

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

describe('ToolsPanel state views', () => {
  it('renders the reusable empty state before a search', () => {
    const html = renderToStaticMarkup(<ToolsPanel trustedRoot="C:/work" />);

    expect(html).toContain('输入关键字搜索工具');
    expect(html).toContain('匹配到的可用工具会显示在这里。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('搜索');
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

  it('renders call actions with Button primitives and preserves disabled state', () => {
    const html = renderToStaticMarkup(
      <ToolsPanelCallActions
        busy
        selectedRequiresApproval
        onCall={() => {}}
        onAddStep={() => {}}
      />,
    );

    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('disabled=""');
    expect(html).toContain('调用中');
    expect(html).toContain('加入计划');
  });

  it('keeps call and plan actions wired through Button primitives', () => {
    const onCall = vi.fn();
    const onAddStep = vi.fn();
    const onRun = vi.fn();
    const onClear = vi.fn();
    const callButtons = collectByType(
      ToolsPanelCallActions({ busy: false, selectedRequiresApproval: false, onCall, onAddStep }),
      Button,
    );
    const planButtons = collectByType(ToolsPanelPlanActions({ onRun, onClear }), Button);

    expect(callButtons).toHaveLength(2);
    expect(planButtons).toHaveLength(2);
    callButtons[0].props.onClick();
    callButtons[1].props.onClick();
    planButtons[0].props.onClick();
    planButtons[1].props.onClick();

    expect(onCall).toHaveBeenCalledOnce();
    expect(onAddStep).toHaveBeenCalledOnce();
    expect(onRun).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
