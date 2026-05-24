import { describe, expect, it } from 'vitest';
import {
  activeConversationMessages,
  compactConversationForStorage,
  compareConversationBranches,
  conversationBranchOptions,
  forkConversationBeforeMessage,
  switchConversationBranch,
  updateActiveConversationMessages,
} from './conversation-branches';
import type { Conversation } from './app-types';

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
    expect(forked?.conversation.branches?.[0].messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
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
    expect(conversationBranchOptions(withNewMessages)[1].description).toBe('2 条共同上下文 · 1 条父线差异 · 1 条分支差异');
  });

  it('compacts branch histories independently for storage', () => {
    const forked = forkConversationBeforeMessage(baseConversation(), 'u2', { branchId: 'b1' })!.conversation;
    const compact = compactConversationForStorage(forked, { messageLimit: 1, branchLimit: 2 });

    expect(compact.branches?.map((branch) => branch.messages.map((message) => message.id))).toEqual([['u2'], ['a1']]);
  });
});
