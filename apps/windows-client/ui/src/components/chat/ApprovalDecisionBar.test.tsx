import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '../../lib/app-types';
import { ApprovalDecisionBar } from './ApprovalDecisionBar';

vi.mock('../../lib/api', () => ({
  respondApproval: vi.fn(),
}));

const baseAssistant: AssistantMessage = {
  id: 'a1',
  role: 'assistant',
  status: 'awaiting_approval',
  text: '',
  progress: [],
  operations: [],
  sources: [],
  approvalState: 'awaiting',
};

function render(approval: AssistantMessage['approval']): string {
  return renderToStaticMarkup(
    <ApprovalDecisionBar message={{ ...baseAssistant, approval }} onPatchAssistant={vi.fn()} />,
  );
}

describe('ApprovalDecisionBar', () => {
  it('renders nothing when there is no pending approval', () => {
    expect(render(undefined)).toBe('');
  });

  it('falls back to a raw JSON dump for non-file previews (e.g. ScheduleTask args)', () => {
    const html = render({ id: 'ap1', name: 'ScheduleTask', risk: 'high', preview: { name: 'daily digest', cron: '0 9 * * *' } });
    expect(html).toContain('daily digest');
    expect(html).toContain('approval-preview');
    expect(html).not.toContain('approval-diff-lines');
  });

  it('renders a line-diff view for a Write/Edit-shaped text preview', () => {
    const html = render({ id: 'ap2', name: 'Edit', risk: 'write', preview: { kind: 'text', path: 'a.txt', before: 'old', after: 'new' } });
    expect(html).toContain('approval-diff-lines');
    expect(html).toContain('a.txt');
    expect(html).toContain('is-remove');
    expect(html).toContain('is-add');
  });

  it('renders a byte-count summary for a binary preview', () => {
    const html = render({ id: 'ap3', name: 'Write', risk: 'write', preview: { kind: 'binary', path: 'img.png', beforeBytes: null, afterBytes: 42 } });
    expect(html).toContain('approval-diff--binary');
    expect(html).toContain('img.png');
    expect(html).toContain('42');
  });

  it('still shows name, risk, and approve/reject actions alongside the diff', () => {
    const html = render({ id: 'ap4', name: 'Write', risk: 'write', preview: { kind: 'text', path: 'a.txt', before: null, after: 'x' } });
    expect(html).toContain('Write');
    expect(html).toContain('write');
    expect(html).toContain('本次批准');
    expect(html).toContain('拒绝');
  });

  it('neutralizes bidi override characters hidden in a JSON preview', () => {
    const rlo = String.fromCharCode(0x202e);
    const html = render({ id: 'ap5', name: 'ScheduleTask', risk: 'high', preview: { name: 'digest' + rlo + 'evil' } });
    expect(html).not.toContain(rlo);
    expect(html).toContain('u202E');
  });
});
