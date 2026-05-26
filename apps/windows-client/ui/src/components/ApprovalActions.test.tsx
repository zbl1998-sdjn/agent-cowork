import { Children, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalActions } from './ApprovalActions';
import { Button } from './ui/Button';

function renderApproval(overrides = {}) {
  return (
    <ApprovalActions
      runId="run-1"
      operations={[]}
      approvalState="awaiting"
      onApprove={vi.fn()}
      onReject={vi.fn()}
      {...overrides}
    />
  );
}

describe('ApprovalActions', () => {
  it('renders terminal approval states without action buttons', () => {
    const approved = renderToStaticMarkup(renderApproval({ approvalState: 'approved' }));
    const rejected = renderToStaticMarkup(renderApproval({ approvalState: 'rejected' }));

    expect(approved).toContain('已审批 · 已写入本机');
    expect(rejected).toContain('已拒绝');
    expect(approved).not.toContain('审批执行');
    expect(rejected).not.toContain('审批执行');
  });

  it('uses Button primitives for the approval CTA surface', () => {
    const html = renderToStaticMarkup(renderApproval({ onViewDiff: vi.fn() }));

    expect(html).toContain('ui-btn--primary');
    expect(html).toContain('ui-btn--secondary');
    expect(html).toContain('ui-btn--danger');
    expect(html).toContain('type="button"');
  });

  it('wires callbacks directly to the existing approval handlers', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onViewDiff = vi.fn();
    const element = ApprovalActions({
      runId: 'run-1',
      operations: [],
      approvalState: 'awaiting',
      onApprove,
      onReject,
      onViewDiff,
    }) as ReactElement;

    const buttons = Children.toArray(element.props.children).filter(isValidElement) as Array<ReactElement<{ onClick: () => void }>>;

    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.type === Button)).toBe(true);

    buttons[0].props.onClick();
    buttons[1].props.onClick();
    buttons[2].props.onClick();

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onViewDiff).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
