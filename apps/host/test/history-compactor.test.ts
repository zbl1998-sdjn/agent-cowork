import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryCompactor, createHistoryCompactor } from '../src/kimi/context/history-compactor.js';
import { HeuristicTokenEstimator } from '../src/kimi/context/token-estimator.js';
import type { ChatMessageLike } from '../src/kimi/context/history-compactor-utils.js';

function makeLongHistory(rounds = 220): ChatMessageLike[] {
  const messages: ChatMessageLike[] = [
    { role: 'system', content: '你是本地 agent。' },
    { role: 'user', content: 'FACT: project=Orion-42\nIMPORTANT: preferred_language=zh-CN' },
  ];
  for (let i = 0; i < rounds; i += 1) {
    messages.push({
      role: 'user',
      content: `round ${i} request ${'alpha beta gamma delta '.repeat(4)}`,
    });
    messages.push({
      role: 'assistant',
      content: `round ${i} answer ${'analysis result detail '.repeat(4)}`,
    });
  }
  return messages;
}

function messageAt(messages: ChatMessageLike[], index: number): ChatMessageLike {
  const message = messages[index];
  assert.ok(message);
  return message;
}

test('history compactor leaves messages unchanged when already under budget', () => {
  const messages = [
    { role: 'system', content: 'system rule' },
    { role: 'user', content: 'short request' },
    { role: 'assistant', content: 'short answer' },
  ];
  const compactor = createHistoryCompactor({ maxContextTokens: 1000 });

  const result = compactor.compact(messages);

  assert.equal(result.compacted, false);
  assert.equal(result.messages.length, messages.length);
  assert.deepEqual(result.messages, messages);
  assert.equal(result.beforeTokens, result.afterTokens);
});

test('history compactor summarizes 200+ old rounds, keeps recent messages, and preserves key facts', () => {
  const estimator = new HeuristicTokenEstimator({ charsPerToken: 4 });
  const messages = makeLongHistory(220);
  const keepRecentMessages = 10;
  const maxContextTokens = 650;
  const compactor = new HistoryCompactor({ estimator, maxContextTokens, keepRecentMessages });

  const result = compactor.compact(messages);
  const expectedTail = messages.slice(-keepRecentMessages);

  assert.equal(result.compacted, true);
  assert.ok(result.beforeTokens > maxContextTokens);
  assert.ok(result.afterTokens <= maxContextTokens, `${result.afterTokens} should fit ${maxContextTokens}`);
  assert.deepEqual(result.messages.slice(-keepRecentMessages), expectedTail);
  const summary = messageAt(result.messages, 0);
  assert.equal(summary.role, 'system');
  assert.match(String(summary.content), /history compacted/i);
  assert.match(String(summary.content), /project=Orion-42/);
  assert.match(String(summary.content), /preferred_language=zh-CN/);
  assert.ok(result.keyFacts.some((fact) => fact.includes('project=Orion-42')));
});

test('history compactor trims retained message content rather than overflowing the budget', () => {
  const estimator = new HeuristicTokenEstimator({ charsPerToken: 4 });
  const messages = [
    { role: 'user', content: 'FACT: run_id=budget-tight' },
    ...makeLongHistory(20),
    { role: 'user', content: `recent huge payload ${'x'.repeat(5000)}` },
    { role: 'assistant', content: 'final answer stays visible' },
  ];
  const compactor = new HistoryCompactor({ estimator, maxContextTokens: 160, keepRecentMessages: 2 });

  const result = compactor.compact(messages);

  assert.equal(result.compacted, true);
  assert.ok(result.afterTokens <= 160, `${result.afterTokens} should fit 160`);
  const summary = messageAt(result.messages, 0);
  const penultimate = messageAt(result.messages, result.messages.length - 2);
  const last = messageAt(result.messages, result.messages.length - 1);
  assert.match(String(summary.content), /run_id=budget-tight/);
  assert.match(String(penultimate.content), /truncated|compacted/i);
  assert.match(String(last.content), /final answer/);
});
