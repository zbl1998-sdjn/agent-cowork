import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChoiceButton } from './ChoiceButton';

describe('ChoiceButton', () => {
  it('renders label and detail through a Button primitive', () => {
    const html = renderToStaticMarkup(
      <ChoiceButton label="继续" detail="保留当前计划" selected onClick={() => {}} />,
    );

    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('is-chosen');
    expect(html).toContain('<strong');
    expect(html).toContain('保留当前计划');
  });

  it('keeps click callbacks wired', () => {
    const onClick = vi.fn();
    const choice = ChoiceButton({ label: '继续', onClick });

    choice.props.onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
