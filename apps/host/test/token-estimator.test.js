import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HeuristicTokenEstimator,
  createHeuristicTokenEstimator,
} from '../src/kimi/context/token-estimator.js';

test('heuristic token estimator gives stable text estimates across scripts', () => {
  const estimator = createHeuristicTokenEstimator();

  assert.equal(estimator.estimateText(''), 0);
  assert.equal(estimator.estimateText(null), 0);
  assert.equal(estimator.estimateText('abcd'.repeat(25)), 25);
  assert.equal(estimator.estimateText('你好世界'), 4);
  assert.ok(estimator.estimateText('hello，世界!') >= 4);
});

test('heuristic token estimator estimates chat messages with per-message overhead', () => {
  const estimator = new HeuristicTokenEstimator({ messageOverheadTokens: 4, replyPrimerTokens: 2 });
  const summary = estimator.estimateMessages([
    { role: 'system', content: '你是一个谨慎的本地 agent。' },
    { role: 'user', content: 'Read a.txt and summarize it.' },
    {
      role: 'assistant',
      tool_calls: [{ function: { name: 'Read', arguments: JSON.stringify({ path: 'a.txt' }) } }],
      content: '',
    },
    { role: 'tool', tool_call_id: 'call_1', content: { ok: true, text: 'done' } },
  ]);

  assert.equal(summary.method, 'heuristic-v1');
  assert.equal(summary.messageCount, 4);
  assert.equal(summary.messages.length, 4);
  assert.ok(summary.totalTokens >= summary.textTokens + 4 * 4 + 2);
  assert.ok(summary.messages[2].textTokens > 0, 'tool call name and args are counted');
  assert.ok(summary.messages[3].textTokens > 0, 'object tool content is counted');
});
