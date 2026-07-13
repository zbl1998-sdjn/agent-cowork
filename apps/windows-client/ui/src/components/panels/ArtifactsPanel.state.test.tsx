import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ArtifactPanelItem, ArtifactsPanel, ArtifactsPanelStateViews } from './ArtifactsPanel';

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

describe('ArtifactsPanel state views', () => {
  it('renders the reusable empty state when there are no artifacts', () => {
    const html = renderToStaticMarkup(<ArtifactsPanel trustedRoot="C:/work" />);

    expect(html).toContain('还没有成果');
    expect(html).toContain('Word、Excel、PPT、PDF、可复制文本或 CSV');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
  });

  it('renders the reusable error state with retry affordance', () => {
    const html = renderToStaticMarkup(<ArtifactsPanelStateViews error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('文件成果加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('renders artifact row actions with Button and Input primitives', () => {
    const item = { path: 'C:/work/.AgentCowork/artifacts/report.md', relativePath: '.AgentCowork/artifacts/report.md', name: 'report.md', kind: 'markdown', size: 42 };
    const html = renderToStaticMarkup(
      <ArtifactPanelItem
        item={item}
        busy={false}
        renaming
        renameText="report-final.md"
        onRenameTextChange={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onOpen={() => {}}
        onBeginRename={() => {}}
      />,
    );

    expect(html).toContain('ui-input');
    expect(html).toContain('ui-btn ui-btn--primary');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('保存');
    expect(html).toContain('重命名');
    expect(html).toContain('aria-label="打开 report.md"');
    expect(html).toContain('aria-label="重命名 report.md"');
    expect(html).toContain('aria-label="保存 report.md 的新名称"');
    expect(html).toContain('草稿文本');
    expect(html).not.toContain('.AgentCowork/artifacts');
    expect(html).not.toContain('<code>report.md</code>');
  });

  it('keeps artifact row callbacks and disabled state wired through primitives', () => {
    const item = { path: 'C:/work/.AgentCowork/artifacts/report.md', name: 'report.md', kind: 'markdown', size: 42 };
    const onRenameTextChange = vi.fn();
    const onCommitRename = vi.fn();
    const onCancelRename = vi.fn();
    const onOpen = vi.fn();
    const onBeginRename = vi.fn();
    const element = ArtifactPanelItem({
      item,
      busy: false,
      renaming: true,
      renameText: 'report-final.md',
      onRenameTextChange,
      onCommitRename,
      onCancelRename,
      onOpen,
      onBeginRename,
    });

    const input = collectByType(element, Input)[0]!;
    const buttons = collectByType(element, Button);
    expect(input).toBeTruthy();
    expect(buttons).toHaveLength(4);
    expect(buttons[0]!.props.disabled).toBe(false);

    input.props.onChange({ target: { value: 'renamed.md' } });
    input.props.onKeyDown({ key: 'Enter' });
    buttons[0]!.props.onClick();
    buttons[1]!.props.onClick();
    buttons[2]!.props.onClick();
    buttons[3]!.props.onClick();

    expect(onRenameTextChange).toHaveBeenCalledWith('renamed.md');
    expect(onCommitRename).toHaveBeenCalledTimes(2);
    expect(onCommitRename).toHaveBeenCalledWith(item);
    expect(onCancelRename).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(item.path);
    expect(onBeginRename).toHaveBeenCalledWith(item);
  });

  it('disables invalid rename submissions before commit', () => {
    const item = { path: 'C:/work/.AgentCowork/artifacts/report.md', name: 'report.md', kind: 'markdown', size: 42 };
    const buttons = collectByType(
      ArtifactPanelItem({
        item,
        busy: false,
        renaming: true,
        renameText: '../escape.md',
        onRenameTextChange: () => {},
        onCommitRename: () => {},
        onCancelRename: () => {},
        onOpen: () => {},
        onBeginRename: () => {},
      }),
      Button,
    );

    expect(buttons[0]!.props.disabled).toBe(true);
  });

  it('exposes an explicit create-version action only for live artifacts', () => {
    const onCreateVersion = vi.fn();
    const element = ArtifactPanelItem({
      item: {
        path: 'C:/work/.AgentCowork/artifacts/viz_report_v1.html',
        name: 'viz_report_v1.html',
        liveArtifactId: 'viz_report_v1',
      },
      busy: false,
      renaming: false,
      renameText: '',
      onRenameTextChange: () => {},
      onCommitRename: () => {},
      onCancelRename: () => {},
      onOpen: () => {},
      onBeginRename: () => {},
      onCreateVersion,
    });
    const buttons = collectByType(element, Button);
    const create = buttons.find((button) => button.props.children === '创建新版本');

    expect(create).toBeTruthy();
    expect(buttons.some((button) => button.props.children === '重命名')).toBe(false);
    create!.props.onClick();
    expect(onCreateVersion).toHaveBeenCalledWith('viz_report_v1');
  });
});
