import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../lib/app-types';
import { ConversationRail } from './ConversationRail';
import { Button, IconButton } from './ui/Button';

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
    ...overrides,
  };
}

describe('ConversationRail', () => {
  it('renders conversation actions with Button primitives', () => {
    const html = renderToStaticMarkup(<ConversationRail {...props()} />);

    expect(html.match(/class="ui-btn /g)?.length).toBe(3);
    expect(html.match(/class="ui-icon-btn/g)?.length).toBe(8);
    expect(html).toContain('new-conv-btn');
    expect(html).toContain('conv-title');
    expect(html).toContain('aria-label="删除"');
    expect(html).toContain('title="导出 Markdown"');
  });

  it('keeps conversation action callbacks wired', () => {
    const callbacks = props();
    const tree = ConversationRail(callbacks);
    const buttons = collectByType(tree, Button);
    const iconButtons = collectByType(tree, IconButton);

    buttons.find((button) => button.props.className === 'new-conv-btn')?.props.onClick();
    buttons.find((button) => button.props.className === 'conv-title')?.props.onClick();
    iconButtons.find((button) => button.props.label === '取消置顶')?.props.onClick();
    iconButtons.find((button) => button.props.label === '导出 Markdown')?.props.onClick();
    iconButtons.find((button) => button.props.label === '重命名')?.props.onClick();
    iconButtons.find((button) => button.props.label === '删除')?.props.onClick();

    expect(callbacks.onNew).toHaveBeenCalledOnce();
    expect(callbacks.onSwitch).toHaveBeenCalledWith('c1');
    expect(callbacks.onTogglePin).toHaveBeenCalledWith('c1');
    expect(callbacks.onExport).toHaveBeenCalledWith('c1');
    expect(callbacks.onSetRenamingId).toHaveBeenCalledWith('c1');
    expect(callbacks.onRenameText).toHaveBeenCalledWith('主线');
    expect(callbacks.onDelete).toHaveBeenCalledWith('c1');
  });
});
