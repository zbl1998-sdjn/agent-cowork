import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppContextRail } from './AppContextRail';
import type { Recipe } from './Composer';

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

const recipes = [
  { id: 'r1', name: '写周报' },
  { id: 'r2', name: '做 PPT' },
] as unknown as Recipe[];

function props(overrides: Partial<Parameters<typeof AppContextRail>[0]> = {}): Parameters<typeof AppContextRail>[0] {
  return {
    trustedRoot: 'C:/Users/Administrator/work',
    recipes,
    streamingId: null,
    mode: 'execute',
    model: 'kimi-k2',
    messageCount: 3,
    onPickRecipe: vi.fn(),
    onToggle: vi.fn(),
    ...overrides,
  };
}

describe('AppContextRail', () => {
  it('renders three cards: run status, working folder, skills — Claude 三栏右栏', () => {
    const html = renderToStaticMarkup(<AppContextRail {...props()} />);
    expect(html).toContain('context-rail');
    expect(html).toContain('上下文');
    expect(html).toContain('运行状态');
    expect(html).toContain('空闲');
    expect(html).toContain('执行');
    expect(html).toContain('工作文件夹');
    expect(html).toContain('work'); // trustedRoot 末段
    expect(html).toContain('技能');
    expect(html).toContain('写周报');
  });

  it('reflects running state while streaming', () => {
    const html = renderToStaticMarkup(<AppContextRail {...props({ streamingId: 'run1' })} />);
    expect(html).toContain('运行中');
    expect(html).toContain('is-running');
  });

  it('wires recipe pick and collapse callbacks', () => {
    const onPickRecipe = vi.fn();
    const onToggle = vi.fn();
    const buttons = collectByType(AppContextRail(props({ onPickRecipe, onToggle })), 'button');

    buttons.find((b) => (b.props.className || '') === 'context-collapse')?.props.onClick();
    buttons.find((b) => (b.props.className || '') === 'context-skill')?.props.onClick();

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onPickRecipe).toHaveBeenCalledWith(recipes[0]);
  });
});
