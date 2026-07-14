import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../lib/app-types';
import { ConversationRail } from './ConversationRail';

function collectByType(node: ReactNode, type: unknown): ReactElement<Record<string, any>>[] {
  const matches: ReactElement<Record<string, any>>[] = [];
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === type) matches.push(child as ReactElement<Record<string, any>>);
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(node);
  return matches;
}

function textOf(value: ReactNode): string {
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (isValidElement(value)) return textOf((value.props as { children?: ReactNode }).children);
  return '';
}

const conversations: Conversation[] = [
  { id: 'c1', title: '主线', pinned: true, messages: [] },
  { id: 'c2', title: '分支讨论', messages: [] },
];

function props(overrides: Partial<Parameters<typeof ConversationRail>[0]> = {}): Parameters<typeof ConversationRail>[0] {
  return {
    activeConvId: 'c1',
    convSearch: '',
    conversations,
    renamingId: null,
    renameText: '',
    panel: 'none',
    onCommitRename: vi.fn(),
    onDelete: vi.fn(),
    onExport: vi.fn(),
    onNew: vi.fn(),
    onRenameText: vi.fn(),
    onSearch: vi.fn(),
    onSetRenamingId: vi.fn(),
    onSwitchBranch: vi.fn(),
    onSwitch: vi.fn(),
    onTogglePin: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
}

describe('ConversationRail', () => {
  it('keeps four outcome-first destinations visible and moves technical panels under more', () => {
    const html = renderToStaticMarkup(<ConversationRail {...props()} />);

    expect(html).toContain('rail-brand');
    expect(html).toContain('Agent Cowork');
    expect(html).toContain('rail-release-badge');
    expect(html).toContain('Beta');
    expect(html).toContain('rail-new');
    expect(html).toContain('新建对话');
    expect(html.match(/rail-nav-item/g)?.length).toBe(4);
    expect(html.match(/rail-more-item/g)?.length).toBe(5);
    expect(html).toContain('任务中心');
    expect(html).toContain('文件成果');
    expect(html).toContain('自动任务');
    expect(html).toContain('可视化编辑');
    expect(html).toContain('<summary>');
    expect(html).toContain('更多功能');
    expect(html).toContain('扩展能力');
    expect(html).toContain('连接外部工具');
    expect(html).toContain('我帮你记住的事');
    expect(html).toContain('成本 / 可观测');
    expect(html).toContain('rail-search');
    expect(html).toContain('最近');
    expect(html).toContain('主线');
    // 底部 footer 已移除(对齐 Claude 极简侧栏,设置/主题走顶栏)
    expect(html).not.toContain('rail-footer');
  });

  it('wires nav, new-chat and conversation callbacks', () => {
    const p = props();
    const buttons = collectByType(ConversationRail(p), 'button');

    buttons.find((b) => (b.props.className || '') === 'rail-new')?.props.onClick();
    buttons.find((b) => (b.props.className || '').includes('rail-more-item') && textOf(b.props.children).includes('扩展能力'))?.props.onClick();
    buttons.find((b) => (b.props.className || '') === 'conv-title' && textOf(b.props.children).includes('主线'))?.props.onClick();
    buttons.find((b) => b.props['aria-label'] === '取消置顶')?.props.onClick();
    buttons.find((b) => b.props['aria-label'] === '删除')?.props.onClick();

    expect(p.onNew).toHaveBeenCalledOnce();
    expect(p.onNavigate).toHaveBeenCalledWith('tools');
    expect(p.onSwitch).toHaveBeenCalledWith('c1');
    expect(p.onTogglePin).toHaveBeenCalledWith('c1');
    expect(p.onDelete).toHaveBeenCalledWith('c1');
  });
});
