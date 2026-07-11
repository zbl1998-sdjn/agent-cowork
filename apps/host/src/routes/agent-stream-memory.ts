// Agent 流式路由的个人记忆辅助(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:构造无原始 owner 的 MASE thread，并封装本地 conversation/knowledge 的读写缝。
import { appendConversationTurn, formatRecentTurns, readRecentTurns } from '../memory/conversation-buffer.js';
import { formatKnowledgeForInjection, recallRelevantKnowledge } from '../memory/knowledge-recall.js';
import { memoryOwnerStorageKey, type MemoryOwnerContext } from '../memory/memory-owner.js';

type RecallOptions = {
  trustedRoot: string;
  conversationId: string;
  prompt: string;
  context: MemoryOwnerContext;
  maseSessionMemory: string;
};

export function buildMaseMemoryThread(context: MemoryOwnerContext, conversationId: string): string {
  return `cowork:${memoryOwnerStorageKey(context)}:${conversationId}`;
}

export function recallBuiltinAgentMemory({
  trustedRoot,
  conversationId,
  prompt,
  context,
  maseSessionMemory,
}: RecallOptions): { sessionMemory: string; knowledgeText: string } {
  const builtinSessionMemory = maseSessionMemory
    ? ''
    : formatRecentTurns(readRecentTurns(trustedRoot, conversationId, { context }));
  return {
    sessionMemory: maseSessionMemory || builtinSessionMemory,
    knowledgeText: formatKnowledgeForInjection(recallRelevantKnowledge(trustedRoot, prompt, { context })),
  };
}

export function rememberBuiltinConversation(
  trustedRoot: string,
  conversationId: string,
  prompt: string,
  response: string,
  context: MemoryOwnerContext,
): void {
  appendConversationTurn(trustedRoot, conversationId, { role: 'user', text: prompt }, { context });
  appendConversationTurn(trustedRoot, conversationId, { role: 'assistant', text: response }, { context });
}
