import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClarificationCard, type ClarificationOption } from './ClarificationCard';
import { ChoiceButton } from './ui/ChoiceButton';

function collectChoices(node: ReactNode): ReactElement<Record<string, any>>[] {
  const matches: ReactElement<Record<string, any>>[] = [];
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === ChoiceButton) matches.push(child as ReactElement<Record<string, any>>);
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(node);
  return matches;
}

const options: ClarificationOption[] = [
  { label: '写周报', detail: '汇总本周进展' },
  { label: '做图表', detail: '生成可视化' },
];

describe('ClarificationCard', () => {
  it('renders options through ChoiceButton primitives', () => {
    const html = renderToStaticMarkup(<ClarificationCard question="你想做什么？" options={options} answer="写周报" onAnswer={() => {}} />);

    expect(html.match(/class="ui-btn /g)?.length).toBe(2);
    expect(html).toContain('clarification-option is-chosen');
    expect(html).toContain('汇总本周进展');
    expect(html).toContain('disabled=""');
  });

  it('keeps option callbacks wired', () => {
    const onAnswer = vi.fn();
    const choices = collectChoices(ClarificationCard({ question: '你想做什么？', options, onAnswer }));

    choices[1].props.onClick();
    expect(onAnswer).toHaveBeenCalledWith(options[1]);
  });
});
