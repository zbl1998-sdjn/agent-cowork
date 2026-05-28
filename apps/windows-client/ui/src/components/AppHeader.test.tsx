import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SidePanel } from '../lib/app-types';
import { AppHeader, AppHeaderActions } from './AppHeader';
import { Button } from './ui/Button';

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

function props(overrides: Partial<Parameters<typeof AppHeader>[0]> = {}): Parameters<typeof AppHeader>[0] {
  return {
    mode: 'execute',
    panel: 'memory',
    theme: 'dark',
    trustedRoot: 'C:/work',
    user: { userId: 'u1', tenantId: 't1', username: 'demo' },
    onLogout: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onOpenSettings: vi.fn(),
    onSetMode: vi.fn(),
    onTogglePanel: vi.fn(),
    onToggleTheme: vi.fn(),
    ...overrides,
  };
}

describe('AppHeader', () => {
  it('renders header actions with Button primitives + a mode dropdown', () => {
    const html = renderToStaticMarkup(<AppHeader {...props()} />);

    // ⌘K + theme + 8 panels + settings + logout = 12 (the 3 mode buttons are
    // gone — replaced by a single <select> so the current mode is always visible).
    expect(html.match(/class="ui-btn /g)?.length).toBe(12);
    expect(html).toContain('Agent Cowork');
    expect(html).toContain('header-user');
    expect(html).toContain('ui-btn--secondary');
    expect(html).toContain('is-active');
    expect(html).toContain('class="mode-select"');
    expect(html).toContain('模式·计划');
    expect(html).toContain('模式·执行');
    expect(html).toContain('模式·YOLO');
  });

  it('keeps header action callbacks wired', () => {
    const onOpenCommandPalette = vi.fn();
    const onToggleTheme = vi.fn();
    const onSetMode = vi.fn();
    const onTogglePanel = vi.fn();
    const onOpenSettings = vi.fn();
    const onLogout = vi.fn();
    const componentProps = props({
      onOpenCommandPalette,
      onToggleTheme,
      onSetMode,
      onTogglePanel,
      onOpenSettings,
      onLogout,
    });
    const tree = AppHeaderActions(componentProps);
    const buttons = collectByType(tree, Button);

    expect(buttons).toHaveLength(12);
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    buttons.find((button) => button.props.children === '记忆')?.props.onClick();
    buttons.find((button) => button.props.children === '⚙ 设置')?.props.onClick();
    buttons.find((button) => button.props.children === '退出')?.props.onClick();

    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(onToggleTheme).toHaveBeenCalledOnce();
    expect(onTogglePanel).toHaveBeenCalledWith('memory' satisfies SidePanel);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();

    // mode <select> is the only one — simulate onChange to verify the callback wiring.
    const selects = collectByType(tree, 'select');
    const modeSelect = selects.find((s) => s.props.className === 'mode-select');
    expect(modeSelect).toBeDefined();
    modeSelect?.props.onChange({ target: { value: 'yolo' } });
    modeSelect?.props.onChange({ target: { value: 'plan' } });
    expect(onSetMode).toHaveBeenCalledWith('yolo');
    expect(onSetMode).toHaveBeenCalledWith('plan');
  });
});
