import assert from 'node:assert/strict';
import test from 'node:test';
import { maybeConsolidatePreviousConversation, __resetConsolidateTriggerState } from '../src/memory/consolidate-trigger.js';
import { appendConversationTurn } from '../src/memory/conversation-buffer.js';
import { listKnowledgeItems } from '../src/memory/knowledge-store.js';
import { tempRoot } from './helpers/host-http.js';

const modelConfig = { provider: 'kimi-api', model: 'kimi-k2.6' } as unknown as Record<string, unknown>;
const cannedCallJson = async () => ([
  { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.95 },
]);

function seed(root: string, convId: string): void {
  appendConversationTurn(root, convId, { role: 'user', text: '我的项目代号是 Phoenix-7。' });
  appendConversationTurn(root, convId, { role: 'assistant', text: '已记住 Phoenix-7。' });
  appendConversationTurn(root, convId, { role: 'user', text: '继续。' });
  appendConversationTurn(root, convId, { role: 'assistant', text: '好的。' });
}

test('first turn in a conversation triggers no consolidation (no previous)', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot('kcw-trig-');
  const { triggeredConversationId, done } = maybeConsolidatePreviousConversation({
    trustedRoot: root, tenantId: 't1', userId: 'u1', conversationId: 'conv-A', modelConfig, callJson: cannedCallJson,
  });
  await done;
  assert.equal(triggeredConversationId, null);
});

test('switching to a new conversation consolidates the previous one', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot('kcw-trig-');
  seed(root, 'conv-A');
  // 第一轮 conv-A:登记为 last-active
  await maybeConsolidatePreviousConversation({ trustedRoot: root, tenantId: 't1', userId: 'u1', conversationId: 'conv-A', modelConfig, callJson: cannedCallJson }).done;
  // 切到 conv-B:应触发 conv-A 的提炼
  const { triggeredConversationId, done } = maybeConsolidatePreviousConversation({
    trustedRoot: root, tenantId: 't1', userId: 'u1', conversationId: 'conv-B', modelConfig, callJson: cannedCallJson,
  });
  await done;
  assert.equal(triggeredConversationId, 'conv-A');
  // conv-A 已被提炼成主题知识
  assert.match(String(listKnowledgeItems(root, { status: 'active' })[0]?.content), /Phoenix-7/);
});

test('staying in the same conversation does not re-consolidate', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot('kcw-trig-');
  seed(root, 'conv-A');
  await maybeConsolidatePreviousConversation({ trustedRoot: root, tenantId: 't1', userId: 'u1', conversationId: 'conv-A', modelConfig, callJson: cannedCallJson }).done;
  const { triggeredConversationId } = maybeConsolidatePreviousConversation({
    trustedRoot: root, tenantId: 't1', userId: 'u1', conversationId: 'conv-A', modelConfig, callJson: cannedCallJson,
  });
  assert.equal(triggeredConversationId, null, 'same conversation must not trigger consolidation');
});

test('different users do not cross-trigger each other', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot('kcw-trig-');
  await maybeConsolidatePreviousConversation({ trustedRoot: root, tenantId: 't1', userId: 'u1', conversationId: 'conv-A', modelConfig, callJson: cannedCallJson }).done;
  // 另一个用户第一次对话,不该因为 u1 的 conv-A 而触发
  const { triggeredConversationId } = maybeConsolidatePreviousConversation({
    trustedRoot: root, tenantId: 't1', userId: 'u2', conversationId: 'conv-Z', modelConfig, callJson: cannedCallJson,
  });
  assert.equal(triggeredConversationId, null);
});
