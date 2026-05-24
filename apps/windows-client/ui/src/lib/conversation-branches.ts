import type { Conversation, ConversationBranch, Message } from './app-types';
import { convTitle } from './conversations';

export const MAIN_BRANCH_ID = 'main';

export interface ConversationBranchComparison {
  leftBranchId: string;
  rightBranchId: string;
  commonPrefixCount: number;
  leftOnlyCount: number;
  rightOnlyCount: number;
  forkLabel: string;
  summary: string;
}

function branchTitle(index: number): string {
  return index === 0 ? '主线' : `分支 ${index}`;
}

function messagePreview(message: Message | undefined): string {
  if (!message) return '起点';
  const text = (message.text || '').trim().replace(/\s+/g, ' ');
  if (text) return text.length > 28 ? `${text.slice(0, 28)}…` : text;
  return message.role === 'assistant' ? '助手回复' : '用户消息';
}

function findBranchMessage(branches: ConversationBranch[], messageId: string | undefined): Message | undefined {
  if (!messageId) return undefined;
  for (const branch of branches) {
    const found = branch.messages.find((message) => message.id === messageId);
    if (found) return found;
  }
  return undefined;
}

function commonPrefixCount(left: Message[], right: Message[]): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count].id === right[count].id) count += 1;
  return count;
}

export function normalizeConversationBranches(conversation: Conversation): Required<Pick<Conversation, 'activeBranchId' | 'branches'>> {
  const rawBranches = Array.isArray(conversation.branches) ? conversation.branches : [];
  const branches = rawBranches.length > 0
    ? rawBranches.map((branch, index) => ({
      id: branch.id || (index === 0 ? MAIN_BRANCH_ID : `branch-${index}`),
      title: branch.title || branchTitle(index),
      parentBranchId: branch.parentBranchId,
      baseMessageId: branch.baseMessageId,
      createdAt: branch.createdAt,
      messages: Array.isArray(branch.messages) ? branch.messages : [],
    }))
    : [{ id: MAIN_BRANCH_ID, title: '主线', messages: conversation.messages || [] }];
  const activeBranchId = branches.some((branch) => branch.id === conversation.activeBranchId)
    ? conversation.activeBranchId!
    : branches[0].id;
  return { activeBranchId, branches };
}

export function activeConversationMessages(conversation: Conversation): Message[] {
  const { activeBranchId, branches } = normalizeConversationBranches(conversation);
  return branches.find((branch) => branch.id === activeBranchId)?.messages || conversation.messages || [];
}

export function updateActiveConversationMessages(conversation: Conversation, messages: Message[]): Conversation {
  const { activeBranchId, branches } = normalizeConversationBranches(conversation);
  const nextBranches = branches.map((branch) => (
    branch.id === activeBranchId ? { ...branch, messages } : branch
  ));
  return { ...conversation, activeBranchId, branches: nextBranches, messages };
}

export function switchConversationBranch(conversation: Conversation, branchId: string): Conversation | null {
  const { branches } = normalizeConversationBranches(conversation);
  const target = branches.find((branch) => branch.id === branchId);
  if (!target) return null;
  return { ...conversation, activeBranchId: target.id, branches, messages: target.messages };
}

export function compareConversationBranches(
  conversation: Conversation,
  leftBranchId: string,
  rightBranchId: string,
): ConversationBranchComparison | null {
  const { branches } = normalizeConversationBranches(conversation);
  const left = branches.find((branch) => branch.id === leftBranchId);
  const right = branches.find((branch) => branch.id === rightBranchId);
  if (!left || !right) return null;
  const common = commonPrefixCount(left.messages, right.messages);
  const baseMessageId = right.baseMessageId || left.baseMessageId;
  const forkLabel = messagePreview(findBranchMessage(branches, baseMessageId));
  const leftOnlyCount = Math.max(0, left.messages.length - common);
  const rightOnlyCount = Math.max(0, right.messages.length - common);
  return {
    leftBranchId: left.id,
    rightBranchId: right.id,
    commonPrefixCount: common,
    leftOnlyCount,
    rightOnlyCount,
    forkLabel,
    summary: `${common} 条共同上下文 · ${leftOnlyCount} 条父线差异 · ${rightOnlyCount} 条分支差异`,
  };
}

export function conversationBranchOptions(conversation: Conversation): Array<{ id: string; label: string; description: string }> {
  const { branches } = normalizeConversationBranches(conversation);
  return branches.map((branch, index) => ({
    id: branch.id,
    label: branch.title || branchTitle(index),
    description: index === 0
      ? `${branch.messages.length} 条消息`
      : (compareConversationBranches(conversation, branch.parentBranchId || branches[0].id, branch.id)?.summary || `${branch.messages.length} 条消息`),
  }));
}

export function forkConversationBeforeMessage(
  conversation: Conversation,
  messageId: string,
  { branchId, now = new Date().toISOString() }: { branchId: string; now?: string },
): { conversation: Conversation; messages: Message[] } | null {
  const normalized = updateActiveConversationMessages(conversation, conversation.messages || []);
  const { activeBranchId, branches } = normalizeConversationBranches(normalized);
  const active = branches.find((branch) => branch.id === activeBranchId);
  if (!active) return null;
  const index = active.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const forkMessages = active.messages.slice(0, index);
  const title = convTitle(forkMessages, conversation.title || '新对话');
  const nextBranch: ConversationBranch = {
    id: branchId,
    title: branchTitle(branches.length),
    parentBranchId: active.id,
    baseMessageId: messageId,
    createdAt: now,
    messages: forkMessages,
  };
  return {
    conversation: {
      ...conversation,
      title,
      activeBranchId: nextBranch.id,
      branches: [...branches, nextBranch],
      messages: forkMessages,
    },
    messages: forkMessages,
  };
}

export function compactConversationForStorage(
  conversation: Conversation,
  { messageLimit = 80, branchLimit = 12 }: { messageLimit?: number; branchLimit?: number } = {},
): Conversation {
  const { activeBranchId, branches } = normalizeConversationBranches(conversation);
  const compactBranches = branches.slice(-branchLimit).map((branch) => ({
    ...branch,
    messages: branch.messages.slice(-messageLimit),
  }));
  const active = compactBranches.find((branch) => branch.id === activeBranchId) || compactBranches[0];
  return {
    ...conversation,
    activeBranchId: active?.id,
    branches: compactBranches,
    messages: active ? active.messages : (conversation.messages || []).slice(-messageLimit),
  };
}
