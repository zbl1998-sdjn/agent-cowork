import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactCard } from './ArtifactCard';
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

describe('ArtifactCard', () => {
  it('renders open action with Button primitive and preserves path callback', () => {
    const onOpen = vi.fn();
    const file = { path: 'C:/work/report.md', relativePath: 'report.md', size: 12 };
    const html = renderToStaticMarkup(<ArtifactCard file={file} onOpen={onOpen} />);
    const buttons = collectByType(ArtifactCard({ file, onOpen }), Button);

    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('在系统中打开');
    buttons[0].props.onClick();
    expect(onOpen).toHaveBeenCalledWith('C:/work/report.md');
  });
});
