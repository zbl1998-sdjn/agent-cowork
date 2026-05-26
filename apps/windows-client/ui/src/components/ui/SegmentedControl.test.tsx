import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';

function collectButtons(node: ReactNode): ReactElement<Record<string, any>>[] {
  const matches: ReactElement<Record<string, any>>[] = [];
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === Button) matches.push(child as ReactElement<Record<string, any>>);
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(node);
  return matches;
}

describe('SegmentedControl', () => {
  it('renders segmented buttons through Button primitives', () => {
    const html = renderToStaticMarkup(
      <SegmentedControl ariaLabel="主题" className="seg" value="light" options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={() => {}} />,
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/class="ui-btn /g)?.length).toBe(2);
  });

  it('keeps option callbacks typed by value', () => {
    const onChange = vi.fn();
    const buttons = collectButtons(
      SegmentedControl({ ariaLabel: '开关', className: 'seg', value: false, options: [{ value: false, label: '关' }, { value: true, label: '开' }], onChange }),
    );

    buttons[1].props.onClick();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
