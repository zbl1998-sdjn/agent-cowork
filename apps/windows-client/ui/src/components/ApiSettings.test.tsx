import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiSettings, ApiSettingsActions } from './ApiSettings';
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

describe('ApiSettings', () => {
  it('renders close affordance through the icon primitive while loading', () => {
    const html = renderToStaticMarkup(<ApiSettings onClose={() => {}} onSaved={() => {}} />);

    expect(html).toContain('API 设置');
    expect(html).toContain('ui-icon-btn modal-close');
    expect(html).toContain('加载中…');
  });

  it('renders modal actions through Button primitives and preserves callbacks', () => {
    const onClearKey = vi.fn();
    const onCancel = vi.fn();
    const onSave = vi.fn();
    const html = renderToStaticMarkup(
      <ApiSettingsActions hasKey busy savedTip="已保存" onClearKey={onClearKey} onCancel={onCancel} onSave={onSave} />,
    );
    const buttons = collectByType(
      ApiSettingsActions({ hasKey: true, busy: false, savedTip: '', onClearKey, onCancel, onSave }),
      Button,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(3);
    expect(html).toContain('ui-btn--danger');
    expect(html).toContain('保存中…');
    expect(html).toContain('disabled=""');
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    buttons[2].props.onClick();
    expect(onClearKey).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
  });
});
