import { describe, expect, it } from 'vitest';
import {
  activeConversationMessages,
  compactConversationForStorage,
  compareConversationBranches,
  conversationBranchOptions,
  forkConversationBeforeMessage,
  shouldApplyHydratedMessages,
  switchConversationBranch,
  updateActiveConversationMessages,
} from './conversation-branches';
import type { Conversation } from './app-types';

// 切会话触发的异步补水(getStoredConversation)可能在用户已「新建对话/再切走」之后才返回。
// 迟到结果若不经守卫直接 setMessages,会把旧会话消息灌进当前(空)会话视图,
// 并被「messages→active 会话」回写 effect 持久化成数据污染(实测截图:新建会话出现旧会话内容)。
describe('shouldApplyHydratedMessages', () => {
  it('applies only when the requested conversation is still active and the view is empty', () => {
    expect(shouldApplyHydratedMessages({ requestedId: 'c-old', activeConvId: 'c-old', currentMessageCount: 0 })).toBe(true);
  });

  it('rejects when the user has already switched to a new conversation (late hydration)', () => {
    expect(shouldApplyHydratedMessages({ requestedId: 'c-old', activeConvId: 'c-new', currentMessageCount: 0 })).toBe(false);
  });

  it('rejects when the view already has messages (user typed meanwhile)', () => {
    expect(shouldApplyHydratedMessages({ requestedId: 'c-old', activeConvId: 'c-old', currentMessageCount: 2 })).toBe(false);
  });
});

function baseConversation(): Conversation {
  return {
    id: 'c1',
    title: '原对话',
    messages: [
      { id: 'u1', role: 'user', text: '原问题' },
      { id: 'a1', role: 'assistant', status: 'done', progress: [], operations: [], sources: [], approvalState: 'idle', text: '原回答' },
      { id: 'u2', role: 'user', text: '继续' },
    ],
  };
}

describe('conversation branches', () => {
  it('treats legacy linear conversations as the main branch', () => {
    const conversation = baseConversation();

    expect(activeConversationMessages(conversation).map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
    expect(conversationBranchOptions(conversation)).toEqual([{ id: 'main', label: '主线', description: '3 条消息' }]);
  });

  it('forks before an edited historical message while preserving the original branch', () => {
    const forked = forkConversationBeforeMessage(baseConversation(), 'u2', {
      branchId: 'b1',
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(forked?.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(forked?.conversation.activeBranchId).toBe('b1');
    expect(forked?.conversation.branches?.map((branch) => branch.id)).toEqual(['main', 'b1']);
    expect(forked?.conversation.branches?.[0]!.messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
    expect(forked?.conversation.branches?.[1]).toMatchObject({
      parentBranchId: 'main',
      baseMessageId: 'u2',
      messages: [{ id: 'u1' }, { id: 'a1' }],
    });
  });

  it('switches branches and updates only the active branch messages', () => {
    const forked = forkConversationBeforeMessage(baseConversation(), 'u2', { branchId: 'b1' })!.conversation;
    const withNewMessages = updateActiveConversationMessages(forked, [
      ...activeConversationMessages(forked),
      { id: 'u3', role: 'user', text: '新分支问题' },
    ]);
    const backToMain = switchConversationBranch(withNewMessages, 'main');

    expect(activeConversationMessages(withNewMessages).map((message) => message.id)).toEqual(['u1', 'a1', 'u3']);
    expect(activeConversationMessages(backToMain!).map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('summarizes branch differences from the fork point', () => {
    const forked = forkConversationBeforeMessage(baseConversation(), 'u2', { branchId: 'b1' })!.conversation;
    const withNewMessages = updateActiveConversationMessages(forked, [
      ...activeConversationMessages(forked),
      { id: 'u3', role: 'user', text: '新分支问题' },
    ]);

    expect(compareConversationBranches(withNewMessages, 'main', 'b1')).toMatchObject({
      commonPrefixCount: 2,
      leftOnlyCount: 1,
      rightOnlyCount: 1,
      forkLabel: '继续',
    });
    expect(conversationBranchOptions(withNewMessages)[1]!.description).toBe('2 条共同上下文 · 1 条父线差异 · 1 条分支差异');
  });

  it('compacts branch histories independently for storage', () => {
    const forked = forkConversationBeforeMessage(baseConversation(), 'u2', { branchId: 'b1' })!.conversation;
    const compact = compactConversationForStorage(forked, { messageLimit: 1, branchLimit: 2 });

    expect(compact.branches?.map((branch) => branch.messages.map((message) => message.id))).toEqual([['u2'], ['a1']]);
  });
});
