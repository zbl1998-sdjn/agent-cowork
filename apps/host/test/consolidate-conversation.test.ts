import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { consolidateConversation } from '../src/memory/consolidate.js';
import { appendConversationTurn, conversationBufferPath, readRecentTurns } from '../src/memory/conversation-buffer.js';
import { listKnowledgeItems } from '../src/memory/knowledge-store.js';
import { tempRoot } from './helpers/host-http.js';

const modelConfig = { provider: 'kimi-api', model: 'kimi-k2.6' } as unknown as Record<string, unknown>;
const owner = { tenantId: 't1', userId: 'u1' };

function seedConversation(root: string, convId: string): void {
  appendConversationTurn(root, convId, { role: 'user', text: '我的项目代号是 Phoenix-7，我是后端负责人张伟。' }, { context: owner });
  appendConversationTurn(root, convId, { role: 'assistant', text: '已记住：项目代号 Phoenix-7，后端负责人张伟。' }, { context: owner });
  appendConversationTurn(root, convId, { role: 'user', text: '顺便查一下今天天气。' }, { context: owner });
  appendConversationTurn(root, convId, { role: 'assistant', text: '今天晴。' }, { context: owner });
}

test('consolidateConversation extracts topic knowledge, stores it, and clears the buffer', async () => {
  const root = tempRoot('kcw-consol-');
  seedConversation(root, 'conv-A');
  // 假 gated callJson:返回罐装知识条目(高置信 → active,低置信 → pending)。
  const callJson = async () => ([
    { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.95 },
    { topic: '身份', title: '负责人', content: '后端负责人是张伟', confidence: 0.9 },
    { topic: '偏好', title: '拿不准的偏好', content: '也许喜欢简洁', confidence: 0.4 },
  ]);
  const res = await consolidateConversation({ trustedRoot: root, conversationId: 'conv-A', modelConfig, callJson, context: owner });
  assert.equal(res.consolidated, true);
  assert.equal(res.stored, 3);
  assert.equal(listKnowledgeItems(root, { status: 'active', context: owner }).length, 2);
  assert.equal(listKnowledgeItems(root, { status: 'pending', context: owner }).length, 1);
  // 提炼后缓冲被清理,避免重复提炼。
  assert.equal(fs.existsSync(conversationBufferPath(root, 'conv-A', owner)), false);
});

test('too-short conversations are skipped (no model call, no items)', async () => {
  const root = tempRoot('kcw-consol-short-');
  appendConversationTurn(root, 'conv-B', { role: 'user', text: '你好' }, { context: owner });
  let called = false;
  const callJson = async () => { called = true; return []; };
  const res = await consolidateConversation({ trustedRoot: root, conversationId: 'conv-B', modelConfig, callJson, minTurns: 4, context: owner });
  assert.equal(res.consolidated, false);
  assert.equal(called, false, 'should not call the model for a too-short conversation');
  assert.equal(listKnowledgeItems(root, { context: owner }).length, 0);
});

test('an empty extraction (nothing worth remembering) still clears the buffer', async () => {
  const root = tempRoot('kcw-consol-empty-');
  seedConversation(root, 'conv-C');
  const res = await consolidateConversation({ trustedRoot: root, conversationId: 'conv-C', modelConfig, callJson: async () => [], context: owner });
  assert.equal(res.consolidated, true);
  assert.equal(res.stored, 0);
  assert.equal(fs.existsSync(conversationBufferPath(root, 'conv-C', owner)), false);
});

test('a failing extraction keeps the buffer for a later retry and does not throw', async () => {
  const root = tempRoot('kcw-consol-fail-');
  seedConversation(root, 'conv-D');
  const res = await consolidateConversation({ trustedRoot: root, conversationId: 'conv-D', modelConfig, callJson: async () => { throw new Error('model down'); }, context: owner });
  assert.equal(res.consolidated, false);
  assert.match(String(res.reason), /fail|error|down/i);
  // 缓冲仍在,可重试
  assert.ok(readRecentTurns(root, 'conv-D', { context: owner }).length >= 4);
});
