// 端到端:自适应上下文压缩阈值真的进了实时压缩路径吗?
// ---------------------------------------------------------------------------
// 不是单测纯函数,而是驱动真实 runAgentChat 运行器 + 真实 resolveAgentContextOptions
// 解析器 + 真实 ContextManager/HistoryCompactor,用真实发出的 `context_compacted`
// 事件观测:同一段历史,在「按模型窗口推导的预算」下不压缩,在「未知模型回落的保守
// 默认」下会压缩——证明模型选择确实改变了运行时压缩行为,而不只是数学对得上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { resolveAgentContextOptions } from '../src/routes/agent-stream-context.js';
import { createHeuristicTokenEstimator } from '../src/kimi/context/token-estimator.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';
import type { ChatMessage } from '../src/kimi/agent/tool-loop-types.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-ctxwin-e2e-'));
}

// 历史规模落在「旧写死默认 12000」与「Claude 派生预算 150000」之间,才能区分两种行为。
function buildHistory(): ChatMessage[] {
  return [
    { role: 'system', content: 'system prompt' },
    ...Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}: ${'lorem ipsum dolor sit amet consectetur '.repeat(120)}`,
    })),
  ];
}

type EmittedEvent = { type: string; payload: Record<string, unknown> };

async function runWithContextOptions(contextOptions: Record<string, unknown>): Promise<EmittedEvent[]> {
  const root = tmp();
  const events: EmittedEvent[] = [];
  const modelCall: ModelCall = async () => ({ content: 'done' });
  const out = await runAgentChat({
    prompt: 'ignored on resume',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    tools: [],
    modelCall,
    emit: (type, payload) => events.push({ type, payload: (payload || {}) as Record<string, unknown> }),
    runStoreRoot: path.join(root, 'runs'),
    resumeState: { messages: buildHistory() },
    contextOptions,
  });
  assert.equal(out.text, 'done');
  return events;
}

test('E2E: model selection changes whether history compaction fires in the real runner', async () => {
  // 前置守卫:历史 token 数确实介于旧默认(12k)与 Claude 派生预算(150k)之间。
  const estimator = createHeuristicTokenEstimator();
  const tokens = estimator.estimateMessages(buildHistory()).totalTokens;
  assert.ok(tokens > 12_000, `history should exceed the old 12k default (got ${tokens})`);
  assert.ok(tokens < 150_000, `history should stay below the claude 150k budget (got ${tokens})`);

  // 真实解析器:选 Claude → 派生 150k 预算。
  const claudeOptions = resolveAgentContextOptions({ prompt: 'x' }, { provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.deepEqual(claudeOptions, { maxContextTokens: 150_000 });
  const claudeEvents = await runWithContextOptions(claudeOptions);
  assert.equal(
    claudeEvents.some((event) => event.type === 'context_compacted'),
    false,
    'a ~40k history must NOT compact when the selected model window is 200k (budget 150k)',
  );

  // 真实解析器:未知模型 → 留空 → compactor 回落到 12k 保守默认。
  const unknownOptions = resolveAgentContextOptions({ prompt: 'x' }, { provider: 'mystery', model: 'unknown-x' });
  assert.deepEqual(unknownOptions, {});
  const unknownEvents = await runWithContextOptions(unknownOptions);
  const compacted = unknownEvents.find((event) => event.type === 'context_compacted');
  assert.ok(compacted, 'the same history MUST compact under the conservative 12k default');
  assert.ok(
    Number(compacted?.payload.beforeTokens) > Number(compacted?.payload.afterTokens),
    'compaction should reduce the token count',
  );
});
