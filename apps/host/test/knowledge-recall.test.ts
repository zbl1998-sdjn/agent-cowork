import assert from 'node:assert/strict';
import test from 'node:test';
import { recallRelevantKnowledge, formatKnowledgeForInjection } from '../src/memory/knowledge-recall.js';
import { upsertKnowledgeItem } from '../src/memory/knowledge-store.js';
import { tempRoot } from './helpers/host-http.js';
const owner = { tenantId: 'tenant_test', userId: 'user_test' };

function seed(root: string): void {
  upsertKnowledgeItem(root, { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.9 }, { confidenceThreshold: 0.7, context: owner });
  upsertKnowledgeItem(root, { topic: '身份', title: '负责人', content: '后端负责人是张伟', confidence: 0.9 }, { confidenceThreshold: 0.7, context: owner });
  upsertKnowledgeItem(root, { topic: '偏好', title: '语言偏好', content: '用户偏好简洁中文回复', confidence: 0.9 }, { confidenceThreshold: 0.7, context: owner });
  // 一条 pending(低置信),不该被召回
  upsertKnowledgeItem(root, { topic: '八卦', title: '待确认', content: '也许喜欢喝咖啡', confidence: 0.3 }, { confidenceThreshold: 0.7, context: owner });
}

test('recallRelevantKnowledge returns active items relevant to the query', () => {
  const root = tempRoot('kcw-recall-');
  seed(root);
  const hits = recallRelevantKnowledge(root, '项目代号是什么', { context: owner });
  assert.ok(hits.length >= 1);
  assert.match(String(hits[0]?.content), /Phoenix-7/);
});

test('irrelevant query returns nothing (relevance-gated, no context pollution)', () => {
  const root = tempRoot('kcw-recall-');
  seed(root);
  const hits = recallRelevantKnowledge(root, '帮我算一下 12 乘 34 等于多少', { context: owner });
  assert.equal(hits.length, 0);
});

test('pending items are never recalled (only active knowledge is injected)', () => {
  const root = tempRoot('kcw-recall-');
  seed(root);
  const hits = recallRelevantKnowledge(root, '咖啡', { context: owner });
  assert.equal(hits.some((it) => /咖啡/.test(it.content)), false, 'pending item must not be recalled');
});

test('recall is capped to the requested limit', () => {
  const root = tempRoot('kcw-recall-');
  for (let i = 0; i < 10; i += 1) {
    upsertKnowledgeItem(root, { topic: '项目', title: `事实${i}`, content: `项目相关事实 ${i}`, confidence: 0.9 }, { confidenceThreshold: 0.7, context: owner });
  }
  const hits = recallRelevantKnowledge(root, '项目', { limit: 3, context: owner });
  assert.ok(hits.length <= 3, `should cap at 3, got ${hits.length}`);
});

test('formatKnowledgeForInjection renders a labeled block; empty input -> empty string', () => {
  const root = tempRoot('kcw-recall-');
  seed(root);
  const block = formatKnowledgeForInjection(recallRelevantKnowledge(root, '负责人 项目代号', { context: owner }));
  assert.match(block, /张伟|Phoenix-7/);
  assert.match(block, /记忆|知识/);
  assert.equal(formatKnowledgeForInjection([]), '');
});
