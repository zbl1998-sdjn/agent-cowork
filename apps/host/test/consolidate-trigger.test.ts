import assert from 'node:assert/strict';
import test from 'node:test';
import { maybeConsolidatePreviousConversation, __resetConsolidateTriggerState } from '../src/memory/consolidate-trigger.js';
import { appendConversationTurn } from '../src/memory/conversation-buffer.js';
import { listKnowledgeItems } from '../src/memory/knowledge-store.js';
import { tempRoot } from './helpers/host-http.js';

const modelConfig = { provider: 'kimi-api', model: 'kimi-k2.6' } as unknown as Record<string, unknown>;
const owner = { tenantId: 't1', userId: 'u1' };
const cannedCallJson = async () => ([
  { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.95 },
]);

function seed(root: string, convId: string): void {
  appendConversationTurn(root, convId, { role: 'user', text: '我的项目代号是 Phoenix-7。' }, { context: owner });
  appendConversationTurn(root, convId, { role: 'assistant', text: '已记住 Phoenix-7。' }, { context: owner });
  appendConversationTurn(root, convId, { role: 'user', text: '继续。' }, { context: owner });
  appendConversationTurn(root, convId, { role: 'assistant', text: '好的。' }, { context: owner });
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
  assert.match(String(listKnowledgeItems(root, { status: 'active', context: owner })[0]?.content), /Phoenix-7/);
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

test('background consolidation exposes a generic rejection and reports no sensitive details', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot('kcw-trig-');
  seed(root, 'conv-secret');
  const reports: unknown[] = [];
  const callJson = async () => {
    throw new Error('provider leaked conversation secret Phoenix-7');
  };
  await maybeConsolidatePreviousConversation({
    trustedRoot: root,
    tenantId: 't1',
    userId: 'u1',
    conversationId: 'conv-secret',
    modelConfig,
    callJson,
    onError: (event) => reports.push(event),
  }).done;

  const { done } = maybeConsolidatePreviousConversation({
    trustedRoot: root,
    tenantId: 't1',
    userId: 'u1',
    conversationId: 'conv-next',
    modelConfig,
    callJson,
    onError: (event) => reports.push(event),
  });
  await assert.rejects(() => done, /^Error: Memory consolidation failed$/);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(reports, [{ operation: 'consolidate' }]);
  assert.doesNotMatch(JSON.stringify(reports), /Phoenix-7|conv-secret|provider leaked/i);
});

test('background consolidation contains reporter failures but keeps done rejected', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot('kcw-trig-');
  seed(root, 'conv-A');
  const callJson = async () => {
    throw new Error('private provider detail');
  };
  await maybeConsolidatePreviousConversation({
    trustedRoot: root,
    tenantId: 't1',
    userId: 'u1',
    conversationId: 'conv-A',
    modelConfig,
    callJson,
  }).done;
  const { done } = maybeConsolidatePreviousConversation({
    trustedRoot: root,
    tenantId: 't1',
    userId: 'u1',
    conversationId: 'conv-B',
    modelConfig,
    callJson,
    onError: () => {
      throw new Error('reporter failed');
    },
  });
  await assert.rejects(() => done, /^Error: Memory consolidation failed$/);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
});

test('too-short consolidation is a successful no-op and malformed owners fail closed', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot('kcw-trig-');
  await maybeConsolidatePreviousConversation({
    trustedRoot: root,
    tenantId: 't1',
    userId: 'u1',
    conversationId: 'conv-A',
    modelConfig,
    callJson: cannedCallJson,
  }).done;
  const result = maybeConsolidatePreviousConversation({
    trustedRoot: root,
    tenantId: 't1',
    userId: 'u1',
    conversationId: 'conv-B',
    modelConfig,
    callJson: cannedCallJson,
  });
  await result.done;

  assert.throws(() => maybeConsolidatePreviousConversation({
    trustedRoot: root,
    tenantId: ' t1',
    userId: 'u1',
    conversationId: 'conv-C',
    modelConfig,
    callJson: cannedCallJson,
  }), /canonical tenantId and userId are required/i);
});
