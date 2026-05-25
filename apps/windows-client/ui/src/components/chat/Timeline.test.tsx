import type { RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '../../lib/app-types';
import { Timeline } from './Timeline';

vi.mock('../../lib/api', () => ({
  answerQuestion: vi.fn(),
  openPath: vi.fn(),
  respondApproval: vi.fn(),
}));

const baseAssistant: AssistantMessage = {
  id: 'a1',
  role: 'assistant',
  status: 'cancelled',
  text: '已取消本轮运行。',
  progress: [],
  operations: [],
  sources: [],
  approvalState: 'idle',
};

function renderTimeline(message: AssistantMessage): string {
  return renderToStaticMarkup(
    <Timeline
      editText=""
      editingMsgId={null}
      empty={false}
      hasNewContent={false}
      isAtBottom
      messages={[message]}
      starters={[]}
      streamingId={null}
      timelineRef={{ current: null } as RefObject<HTMLElement>}
      trustedRoot="C:/work"
      onBeginEdit={vi.fn()}
      onCopyText={vi.fn()}
      onHandleApprove={vi.fn()}
      onOpenOrPreview={vi.fn()}
      onPatchAssistant={vi.fn()}
      onQuickSend={vi.fn()}
      onRegenerate={vi.fn()}
      onScrollToBottom={vi.fn()}
      onSetEditingMsgId={vi.fn()}
      onSetEditText={vi.fn()}
      onSubmitEdit={vi.fn()}
    />,
  );
}

describe('Timeline', () => {
  it('shows continue actions for cancelled and failed assistant turns', () => {
    const cancelled = renderTimeline(baseAssistant);
    const failed = renderTimeline({ ...baseAssistant, id: 'a2', status: 'failed', text: '执行失败。' });

    expect(cancelled).toContain('已取消本轮运行。');
    expect(cancelled).toContain('>继续</button>');
    expect(failed).toContain('执行失败。');
    expect(failed).toContain('>继续</button>');
  });
});
