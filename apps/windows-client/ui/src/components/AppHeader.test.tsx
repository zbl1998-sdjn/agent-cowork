import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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

function textOf(value: ReactNode): string {
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (isValidElement(value)) return textOf((value.props as { children?: ReactNode }).children);
  return '';
}

function props(overrides: Partial<Parameters<typeof AppHeader>[0]> = {}): Parameters<typeof AppHeader>[0] {
  return {
    mode: 'execute',
    theme: 'dark',
    trustedRoot: 'C:/work',
    user: { userId: 'u1', tenantId: 't1', username: 'demo' },
    sidebarCollapsed: false,
    onLogout: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onSetMode: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onToggleTheme: vi.fn(),
    onToggleSidebar: vi.fn(),
    ...overrides,
  };
}

describe('AppHeader', () => {
  it('renders a minimal header: workspace + mode select + cmdk + more menu', () => {
    const html = renderToStaticMarkup(<AppHeader {...props()} />);

    // 极简顶栏:workspace-chip + ⌘K + 外观 + 安装包 + 退出 = 5 个 ui-btn
    // 品牌与 8 个面板入口已下沉到左侧导航栏,顶栏不再承载它们。
    expect(html.match(/class="ui-btn /g)?.length).toBe(5);
    expect(html).toContain('workspace-switcher');
    expect(html).toContain('workspace-chip');
    expect(html).toContain('class="mode-select"');
    expect(html).toContain('模式·计划');
    expect(html).toContain('模式·执行');
    expect(html).toContain('模式·YOLO');
    expect(html).toContain('header-cmdk');
    expect(html).toContain('header-more');
    expect(html).toContain('header-more-user');
    expect(html).toContain('demo');
    expect(html).not.toContain('header-more-panel-grid');
  });

  it('keeps header action callbacks wired', () => {
    const onOpenCommandPalette = vi.fn();
    const onToggleTheme = vi.fn();
    const onSetMode = vi.fn();
    const onLogout = vi.fn();
    const tree = AppHeaderActions(props({ onOpenCommandPalette, onToggleTheme, onSetMode, onLogout }));
    const buttons = collectByType(tree, Button);

    // ⌘K + 外观 + 安装包 + 退出 = 4
    expect(buttons).toHaveLength(4);
    buttons.find((b) => (b.props.className || '').includes('header-cmdk'))?.props.onClick();
    buttons.find((b) => textOf(b.props.children).includes('外观'))?.props.onClick();
    buttons.find((b) => textOf(b.props.children).includes('退出'))?.props.onClick();

    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(onToggleTheme).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();

    const selects = collectByType(tree, 'select');
    const modeSelect = selects.find((s) => s.props.className === 'mode-select');
    expect(modeSelect).toBeDefined();
    modeSelect?.props.onChange({ target: { value: 'yolo' } });
    modeSelect?.props.onChange({ target: { value: 'plan' } });
    expect(onSetMode).toHaveBeenCalledWith('yolo');
    expect(onSetMode).toHaveBeenCalledWith('plan');
  });
});
