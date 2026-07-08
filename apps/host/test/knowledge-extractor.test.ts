import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKnowledgeExtractionPrompt,
  normalizeKnowledgeItems,
  formatConversationForExtraction,
} from '../src/memory/knowledge-extractor.js';
import type { ConversationTurn } from '../src/memory/conversation-buffer.js';

test('normalizeKnowledgeItems parses valid topic knowledge items with confidence', () => {
  const items = normalizeKnowledgeItems([
    { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.9 },
    { topic: '偏好', title: '回复偏好', content: '用户偏好简洁中文', confidence: 0.6 },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.topic, '项目');
  assert.equal(items[0]?.title, '项目代号');
  assert.match(String(items[0]?.content), /Phoenix-7/);
  assert.equal(items[0]?.confidence, 0.9);
});

test('normalizeKnowledgeItems tolerates field aliases and an {items:[...]} wrapper', () => {
  const items = normalizeKnowledgeItems({
    items: [
      { 主题: '项目', 标题: '负责人', 内容: '后端负责人是张伟', 置信度: 0.8 },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.topic, '项目');
  assert.match(String(items[0]?.content), /张伟/);
  assert.equal(items[0]?.confidence, 0.8);
});

test('normalizeKnowledgeItems drops empty/invalid entries and clamps confidence to [0,1]', () => {
  const items = normalizeKnowledgeItems([
    { topic: '', title: '', content: '' },
    { topic: '项目', title: '无内容' },
    { topic: '项目', title: '有内容', content: '有效知识', confidence: 5 },
    { topic: '项目', title: '负置信', content: '另一条', confidence: -3 },
    'not an object',
  ]);
  // 只保留有 content 的两条;置信度夹到 [0,1]
  assert.equal(items.length, 2);
  assert.equal(items[0]?.confidence, 1);
  assert.equal(items[1]?.confidence, 0);
});

test('normalizeKnowledgeItems returns [] for non-array/non-items garbage', () => {
  assert.deepEqual(normalizeKnowledgeItems(null), []);
  assert.deepEqual(normalizeKnowledgeItems('nope'), []);
  assert.deepEqual(normalizeKnowledgeItems({ foo: 'bar' }), []);
});

test('normalizeKnowledgeItems caps the number of items (avoid pollution from one over-eager extraction)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ topic: 't', title: `k${i}`, content: `v${i}`, confidence: 0.9 }));
  const items = normalizeKnowledgeItems(many);
  assert.ok(items.length <= 20, `should cap items, got ${items.length}`);
});

test('formatConversationForExtraction renders a role-labeled transcript', () => {
  const turns: ConversationTurn[] = [
    { role: 'user', text: '我叫张伟', ts: '' },
    { role: 'assistant', text: '你好张伟', ts: '' },
  ];
  const text = formatConversationForExtraction(turns);
  assert.match(text, /张伟/);
  assert.match(text, /用户|user|助手|assistant/i);
});

test('buildKnowledgeExtractionPrompt returns a conservative JSON-only instruction', () => {
  const { system, user } = buildKnowledgeExtractionPrompt('用户: 我的项目代号是 Phoenix-7');
  assert.match(system + user, /JSON/);
  assert.match(user, /Phoenix-7/);
  // 保守约束:必须提示只提取耐用知识、跳过闲聊/一次性任务、不编造、不含密钥
  assert.match(user, /耐用|长期|跳过|闲聊|不编造|不要编造|机密|密钥|敏感/);
});
