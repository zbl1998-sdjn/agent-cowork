// 步数收尾提醒(不要总是把步数耗尽)——确定性验证
// ---------------------------------------------------------------------------
// 用一个「永远只回工具调用、从不收尾」的假模型驱动真实 runAgentChat,观测:用掉约
// 70% 步数后,循环会注入一次【收尾提醒】软提醒(且只注入一次),鼓励模型收敛。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/engine/agent-runner.js';
import { stepBudgetNudgeMessage } from '../src/engine/agent/tool-loop-support.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { ModelCall } from '../src/engine/agent/model-resilience.js';
import type { ChatMessage } from '../src/engine/agent/tool-loop-types.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-step-budget-'));
}

function contentsOf(messages: unknown): string[] {
  return (messages as ChatMessage[]).map((m) => String((m as { content?: unknown }).content ?? ''));
}

function nudgeCount(contents: string[]): number {
  return contents.filter((c) => c.includes('【收尾提醒】')).length;
}

test('stepBudgetNudgeMessage fires only after ~70% of the budget, once', () => {
  // budget 4 → threshold ceil(2.8)=3
  assert.equal(stepBudgetNudgeMessage(1, 4), null);
  assert.equal(stepBudgetNudgeMessage(2, 4), null);
  assert.ok(stepBudgetNudgeMessage(3, 4)?.content.includes('【收尾提醒】'));
  assert.equal(stepBudgetNudgeMessage(3, 4)?.role, 'user');
  // degenerate budgets never nudge
  assert.equal(stepBudgetNudgeMessage(1, 1), null);
  assert.equal(stepBudgetNudgeMessage(1, 0), null);
  // ratio<=0 disables the nudge entirely (deployment tuning / A-B control)
  assert.equal(stepBudgetNudgeMessage(4, 4, 0), null);
  assert.equal(stepBudgetNudgeMessage(4, 4, -1), null);
  // a lower ratio fires earlier
  assert.ok(stepBudgetNudgeMessage(2, 4, 0.5)?.content.includes('【收尾提醒】'));
});

test('runAgentChat injects the wrap-up reminder once when the model keeps calling tools', async () => {
  const root = tmp();
  const tools = [{
    name: 'Noop',
    risk: 'safe',
    mutating: false,
    description: 'does nothing',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ ok: true }),
  }];
  const seenPerCall: string[][] = [];
  const events: string[] = [];
  let calls = 0;
  // Always return a tool call — never finalize — to force the loop toward its budget.
  const modelCall: ModelCall = async ({ messages }) => {
    calls += 1;
    seenPerCall.push(contentsOf(messages));
    return { content: '', tool_calls: [{ id: `c${calls}`, function: { name: 'Noop', arguments: '{}' } }] };
  };

  await runAgentChat({
    prompt: 'keep going',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    maxSteps: 4,
    autoApprove: true,
    emit: (type) => events.push(type),
    runStoreRoot: path.join(root, 'runs'),
  });

  const callAt = (i: number): string[] => {
    const view = seenPerCall[i];
    assert.ok(view, `model call #${i + 1} should have happened`);
    return view;
  };
  // budget 4 → threshold at step 3. No reminder before that.
  assert.equal(nudgeCount(callAt(0)), 0, 'no reminder on step 1');
  assert.equal(nudgeCount(callAt(1)), 0, 'no reminder on step 2');
  assert.equal(nudgeCount(callAt(2)), 1, 'reminder injected on step 3 (≈70% of budget)');
  // still exactly one on the next model turn (injected once, not per-step spam)
  assert.equal(nudgeCount(callAt(3)), 1, 'reminder not duplicated on step 4');
  assert.ok(events.includes('step_budget_reminder'), 'a step_budget_reminder event is emitted');
});
