import type { RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Message, UserMessage } from '../../lib/app-types';
import {
  Timeline,
  assistantTurnPropsEqual,
  computeTimelineWindow,
  userEditTurnPropsEqual,
  userTurnPropsEqual,
  type AssistantTurnProps,
  type UserEditTurnProps,
  type UserTurnProps,
} from './Timeline';
import { UserEditTurn, UserTurn } from './TimelineTurns';

vi.mock('../../lib/api', () => ({
  answerQuestion: vi.fn(),
  openPath: vi.fn(),
  respondApproval: vi.fn(),
  respondApprovals: vi.fn(),
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

const baseUser: UserMessage = { id: 'u1', role: 'user', text: '请帮我修改文件' };

function assistantTurnProps(overrides: Partial<AssistantTurnProps> = {}): AssistantTurnProps {
  return {
    message: baseAssistant,
    streamingId: null,
    trustedRoot: 'C:/work',
    onCopyText: vi.fn(),
    onHandleApprove: vi.fn(),
    onOpenOrPreview: vi.fn(),
    onPatchAssistant: vi.fn(),
    onQuickSend: vi.fn(),
    onRegenerate: vi.fn(),
    ...overrides,
  };
}

function userTurnProps(overrides: Partial<UserTurnProps> = {}): UserTurnProps {
  return {
    message: baseUser,
    streamingId: null,
    onBeginEdit: vi.fn(),
    ...overrides,
  };
}

function userEditTurnProps(overrides: Partial<UserEditTurnProps> = {}): UserEditTurnProps {
  return {
    editText: baseUser.text,
    message: baseUser,
    onSetEditingMsgId: vi.fn(),
    onSetEditText: vi.fn(),
    onSubmitEdit: vi.fn(),
    ...overrides,
  };
}

function renderTimeline(messages: Message[] | Message): string {
  return renderToStaticMarkup(
    <Timeline
      editText=""
      editingMsgId={null}
      empty={false}
      hasNewContent={false}
      isAtBottom
      messages={Array.isArray(messages) ? messages : [messages]}
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

  it('shows exact-ID batch approval actions only when multiple approvals are visible', () => {
    const single = renderTimeline({
      ...baseAssistant,
      id: 'a3',
      status: 'awaiting_approval',
      text: undefined,
      approval: { id: 'apr_one', name: 'Shell' },
    });
    const batch = renderTimeline([
      { ...baseAssistant, id: 'a4', status: 'awaiting_approval', text: undefined, approval: { id: 'apr_one', name: 'Shell' } },
      { ...baseAssistant, id: 'a5', status: 'awaiting_approval', text: undefined, approval: { id: 'apr_two', name: 'Write' } },
    ]);

    expect(single).not.toContain('批准当前 2 个');
    expect(batch).toContain('待批准操作');
    expect(batch).toContain('批准当前 2 个');
    expect(batch).toContain('本会话批准当前 2 个');
    expect(batch).toContain('ui-btn--primary');
    expect(batch).toContain('ui-btn--secondary');
  });

  it('renders plan and approval bars with Button primitives', () => {
    const plan = renderTimeline({
      ...baseAssistant,
      id: 'a-plan',
      status: 'awaiting_approval',
      text: undefined,
      plan: { id: 'plan_1', text: '1. 检查文件' },
    });
    const approval = renderTimeline({
      ...baseAssistant,
      id: 'a-approval',
      status: 'awaiting_approval',
      text: undefined,
      approval: { id: 'apr_one', name: 'Shell' },
    });

    expect(plan).toContain('计划待批准');
    expect(plan).toContain('批准并执行');
    expect(plan).toContain('继续完善');
    expect(plan).toContain('ui-btn--primary');
    expect(plan).toContain('ui-btn--secondary');
    expect(approval).toContain('需要批准操作');
    expect(approval).toContain('本次批准');
    expect(approval).toContain('本会话批准');
    expect(approval).toContain('ui-btn--danger');
  });

  it('keeps assistant turns memoized unless render-sensitive props change', () => {
    const props = assistantTurnProps();

    expect(assistantTurnPropsEqual(props, { ...props })).toBe(true);
    expect(assistantTurnPropsEqual(props, { ...props, message: { ...baseAssistant } })).toBe(false);
    expect(assistantTurnPropsEqual(props, { ...props, streamingId: baseAssistant.id })).toBe(false);
    expect(assistantTurnPropsEqual(props, { ...props, onRegenerate: vi.fn() })).toBe(false);
  });

  it('keeps user turns memoized across unrelated assistant streaming updates', () => {
    const props = userTurnProps();

    expect(userTurnPropsEqual(props, { ...props })).toBe(true);
    expect(userTurnPropsEqual(props, { ...props, message: { ...baseUser } })).toBe(false);
    expect(userTurnPropsEqual(props, { ...props, streamingId: 'a1' })).toBe(false);
  });

  it('keeps user edit turns memoized until edit state or handlers change', () => {
    const props = userEditTurnProps();

    expect(userEditTurnPropsEqual(props, { ...props })).toBe(true);
    expect(userEditTurnPropsEqual(props, { ...props, editText: '新内容' })).toBe(false);
    expect(userEditTurnPropsEqual(props, { ...props, onSubmitEdit: vi.fn() })).toBe(false);
  });

  it('renders user edit actions with Button primitives', () => {
    const html = renderToStaticMarkup(<UserEditTurn {...userEditTurnProps()} />);

    expect(html).toContain('取消');
    expect(html).toContain('重新发送');
    expect(html).toContain('ui-btn--secondary');
    expect(html).toContain('ui-btn--primary');
  });

  it('renders the user edit trigger with the Button primitive when not streaming', () => {
    const editable = renderToStaticMarkup(<UserTurn {...userTurnProps()} />);
    const streaming = renderToStaticMarkup(<UserTurn {...userTurnProps({ streamingId: 'a1' })} />);

    expect(editable).toContain('编辑并重新发送');
    expect(editable).toContain('ui-btn ui-btn--ghost ui-btn--md user-edit-btn');
    expect(editable).toContain('✎ 编辑');
    expect(streaming).not.toContain('编辑并重新发送');
  });

  it('windows long timelines around the bottom when the view is stuck', () => {
    const messages: Message[] = Array.from({ length: 180 }, (_, index) => ({
      id: `u${index}`,
      role: 'user',
      text: `消息 ${index}`,
    }));
    const win = computeTimelineWindow(messages, { scrollTop: 0, viewportHeight: 720 }, true);

    expect(win.virtualized).toBe(true);
    expect(win.startIndex).toBeGreaterThan(0);
    expect(win.endIndex).toBe(179);
    expect(win.messages.at(-1)?.id).toBe('u179');
    expect(win.topSpacer).toBeGreaterThan(0);
  });

  it('renders only the active message window for long conversations', () => {
    const messages: Message[] = Array.from({ length: 180 }, (_, index) => ({
      id: `u${index}`,
      role: 'user',
      text: `长会话消息 ${index}`,
    }));
    const html = renderTimeline(messages);

    expect(html).toContain('data-virtualized="true"');
    expect(html).toContain('长会话消息 179');
    expect(html).not.toContain('长会话消息 0');
  });
});
