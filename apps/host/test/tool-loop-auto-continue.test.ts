// 自动续跑:单条消息任务太大跑满步数时,自动用新一窗步数接着跑,直到完成或到硬上限。
// ---------------------------------------------------------------------------
// 用"永不收尾、只回工具调用"的假模型驱动真实 runAgentChat,验证:
//   1) maxAutoContinues>0 时,总工具轮数会扩展到硬上限(maxSteps*(1+maxAutoContinues)),
//      期间发出 auto_continue 事件,结果标 stepsExhausted;
//   2) maxAutoContinues=0 时退回旧行为(只跑一窗);
//   3) 模型自然收尾时不触发续跑、不标 exhausted。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/engine/agent-runner.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { ModelCall } from '../src/engine/agent/model-resilience.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-auto-continue-'));
}

const NOOP_TOOL = {
  name: 'Noop',
  risk: 'safe',
  mutating: false,
  description: 'does nothing',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ ok: true }),
};

// 每轮工具参数带唯一序号,避免相同指纹触发 loop-guard(那会提前打断,干扰本测试的步数观测)。
function toolRoundCounter() {
  let calls = 0;
  const events: string[] = [];
  const modelCall: ModelCall = async () => {
    calls += 1;
    return { content: '', tool_calls: [{ id: `c${calls}`, function: { name: 'Noop', arguments: JSON.stringify({ n: calls }) } }] };
  };
  return { modelCall, events };
}

test('auto-continue extends the step budget up to the hard cap when the model keeps working', async () => {
  const root = tmp();
  const c = toolRoundCounter();
  const out = await runAgentChat({
    prompt: 'big task',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools: [NOOP_TOOL],
    modelCall: c.modelCall,
    maxSteps: 3,
    maxAutoContinues: 2, // hard cap = 3 * (1 + 2) = 9 tool rounds
    autoApprove: true,
    emit: (type) => c.events.push(type),
    runStoreRoot: path.join(root, 'runs'),
  });
  // ran well past the single-window budget of 3, up to the 9-round hard cap
  assert.equal(out.steps.length, 9, 'should extend to maxSteps*(1+maxAutoContinues)=9 tool rounds');
  assert.equal(c.events.filter((e) => e === 'auto_continue').length, 2, 'two auto_continue extensions');
  assert.equal(out.stepsExhausted, true, 'still working at the hard cap → stepsExhausted');
  assert.equal(out.autoContinues, 2);
});

test('maxAutoContinues=0 keeps the old single-window behavior', async () => {
  const root = tmp();
  const c = toolRoundCounter();
  const out = await runAgentChat({
    prompt: 'big task',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools: [NOOP_TOOL],
    modelCall: c.modelCall,
    maxSteps: 3,
    maxAutoContinues: 0,
    autoApprove: true,
    emit: (type) => c.events.push(type),
    runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(out.steps.length, 3, 'only the single 3-step window runs');
  assert.equal(c.events.includes('auto_continue'), false);
  assert.equal(out.stepsExhausted, true, 'exhausted the single window while still working');
  assert.equal(out.autoContinues, 0);
});

test('a naturally finishing run does not auto-continue and is not marked exhausted', async () => {
  const root = tmp();
  const events: string[] = [];
  let calls = 0;
  const modelCall: ModelCall = async () => {
    calls += 1;
    if (calls === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'Noop', arguments: '{}' } }] };
    return { content: '做完了。' };
  };
  const out = await runAgentChat({
    prompt: 'small task',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools: [NOOP_TOOL],
    modelCall,
    maxSteps: 6,
    maxAutoContinues: 2,
    autoApprove: true,
    emit: (type) => events.push(type),
    runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(out.text, '做完了。');
  assert.equal(events.includes('auto_continue'), false);
  assert.equal(out.stepsExhausted, false);
  assert.equal(out.autoContinues, 0);
});
