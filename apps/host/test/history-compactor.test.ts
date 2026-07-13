import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryCompactor, createHistoryCompactor } from '../src/engine/context/history-compactor.js';
import { HeuristicTokenEstimator } from '../src/engine/context/token-estimator.js';
import type { ChatMessageLike } from '../src/engine/context/history-compactor-utils.js';

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
  // 首条 system 消息(指令/记忆)被保护、原样保留在最前;历史摘要放其后一条。
  const preservedSystem = messageAt(result.messages, 0);
  assert.equal(preservedSystem.role, 'system');
  assert.match(String(preservedSystem.content), /你是本地 agent。/);
  const summary = messageAt(result.messages, 1);
  assert.equal(summary.role, 'system');
  assert.match(String(summary.content), /history compacted/i);
  assert.match(String(summary.content), /project=Orion-42/);
  assert.match(String(summary.content), /preferred_language=zh-CN/);
  assert.ok(result.keyFacts.some((fact) => fact.includes('project=Orion-42')));
});

// dogfood 2026-07-09 修复(问题B):长上下文压缩时,注入到首条 system 消息的工作区记忆必须被保护,
// 不能被折进摘要/尾截断丢掉(此前小窗口/大记忆下,长对话里 agent 会丢掉长期记忆)。
test('history compactor preserves the injected workspace memory in the leading system message', () => {
  const estimator = new HeuristicTokenEstimator({ charsPerToken: 4 });
  const MEMORY_MARK = '工作区记忆：内部代号 蓝鲸-42(务必记住)';
  const messages: ChatMessageLike[] = [
    { role: 'system', content: `你是本地 agent。\n${MEMORY_MARK}` },
    ...makeLongHistory(220).slice(1),
  ];
  const compactor = new HistoryCompactor({ estimator, maxContextTokens: 400, keepRecentMessages: 4 });

  const result = compactor.compact(messages);

  assert.equal(result.compacted, true);
  // 关键:压缩后首条仍是原 system 消息,记忆标记完整未丢。
  assert.equal(messageAt(result.messages, 0).role, 'system');
  assert.match(String(messageAt(result.messages, 0).content), /蓝鲸-42/);
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
