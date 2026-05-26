import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import {
  ObservabilityEmptyState,
  ObservabilityErrorState,
  ObservabilityRefreshAction,
  ObservabilityRunList,
  ObservabilityPanel,
} from './ObservabilityPanel';

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

describe('ObservabilityPanel state views', () => {
  it('renders reusable empty states when there are no run records', () => {
    const html = renderToStaticMarkup(<ObservabilityPanel />);

    expect(html).toContain('暂无运行记录');
    expect(html).toContain('完成一次 agent 运行后会显示在这里。');
    expect(html).toContain('选择一条运行记录查看明细');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders reusable empty states for detail rows', () => {
    const html = renderToStaticMarkup(<ObservabilityEmptyState title="未记录耗时" />);

    expect(html).toContain('未记录耗时');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders load failures with ErrorState and retry affordance', () => {
    const html = renderToStaticMarkup(<ObservabilityErrorState error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('运行记录加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('renders refresh with the Button primitive and preserves busy copy', () => {
    const html = renderToStaticMarkup(<ObservabilityRefreshAction loading onRefresh={() => {}} />);

    expect(html).toContain('ui-btn ui-btn--primary');
    expect(html).toContain('disabled=""');
    expect(html).toContain('刷新中');
  });

  it('renders run selection actions with Button primitives', () => {
    const html = renderToStaticMarkup(
      <ObservabilityRunList
        records={[
          { id: 'run-a', type: 'agent', status: 'done', promptPreview: 'First run' },
          { id: 'run-b', type: 'agent', status: 'failed', promptPreview: 'Second run' },
        ]}
        selectedId="run-b"
        onSelectRecord={() => {}}
      />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(2);
    expect(html).toContain('is-selected');
    expect(html).toContain('First run');
    expect(html).toContain('Second run');
  });

  it('keeps run selection wired to the selected record id', () => {
    const onSelectRecord = vi.fn();
    const buttons = collectByType(
      ObservabilityRunList({
        records: [
          { id: 'run-a', type: 'agent', status: 'done', promptPreview: 'First run' },
          { id: 'run-b', type: 'agent', status: 'failed', promptPreview: 'Second run' },
        ],
        selectedId: 'run-a',
        onSelectRecord,
      }),
      Button,
    );

    expect(buttons).toHaveLength(2);
    buttons[1].props.onClick();

    expect(onSelectRecord).toHaveBeenCalledOnce();
    expect(onSelectRecord).toHaveBeenCalledWith('run-b');
  });
});
