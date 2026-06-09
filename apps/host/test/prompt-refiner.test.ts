import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePromptForRefine } from '../src/kimi/prompt/refine-policy.js';
import { createPromptRefiner, refinePrompt } from '../src/kimi/prompt/refiner.js';

test('refine policy asks for clarification when the prompt is too vague', () => {
  const result = analyzePromptForRefine('帮我处理一下');
  assert.equal(result.needsClarification, true);
  assert.equal(result.shouldRefine, false);
  assert.deepEqual(result.missing, ['action', 'target', 'desiredOutput']);
});

// 足够明确的长提示:动作(审查/列出)+ 对象(server.js)+ 产出(表格清单)+ 篇幅 ≥ 阈值。
const EXPLICIT_PROMPT = '请审查 apps/host/src/server.js 的鉴权与会话校验逻辑,逐条列出所有高风险问题及其触发条件,并输出一份包含风险等级、影响范围与修复建议的表格清单。';

test('refine policy keeps explicit prompts refine-eligible (skip decided downstream)', () => {
  const result = analyzePromptForRefine(EXPLICIT_PROMPT);
  assert.equal(result.needsClarification, false);
  assert.equal(result.shouldRefine, true);
  assert.equal(result.explicit, true);
  assert.deepEqual(result.missing, []);
});

test('prompt refiner leaves an already-explicit prompt unchanged when no model is available', async () => {
  const result = await refinePrompt(EXPLICIT_PROMPT, {}, {});
  assert.equal(result.changed, false);
  assert.equal(result.refined, EXPLICIT_PROMPT);
});

test('prompt refiner uses model output when injected', async () => {
  const refiner = createPromptRefiner({
    modelCall: async ({ prompt, intent }) => `请分析 ${prompt}，任务类型=${intent}，并输出可执行步骤。`,
  });

  const result = await refiner.refine('分析当前项目测试覆盖薄弱点');

  assert.equal(result.changed, true);
  assert.equal(result.intent, 'review');
  assert.match(result.refined, /可执行步骤/);
  assert.deepEqual(result.missing, []);
});

test('prompt refiner falls back to original text when model refinement fails', async () => {
  const result = await refinePrompt('分析当前项目测试覆盖薄弱点', {}, {
    modelCall: async () => {
      throw new Error('model unavailable');
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.refined, '分析当前项目测试覆盖薄弱点');
  assert.deepEqual(result.missing, []);
});

test('refine policy covers common verbs/objects and long sentences', () => {
  // 动作/对象词表放宽:「处理 / 登录 / 报错」等常见说法现在能被识别为有意图。
  const recognized = analyzePromptForRefine('把登录那块的报错处理一下');
  assert.equal(recognized.needsClarification, false);
  assert.equal(recognized.shouldRefine, true);

  // 够长兜底:没命中任何词表,但句子够长 → 仍按带意图处理,交给改写器。
  const longish = analyzePromptForRefine('我那个东西最近老是怪怪的你帮我弄一弄看看能不能好');
  assert.equal(longish.needsClarification, false);
  assert.equal(longish.shouldRefine, true);

  // 仍然追问:又短、又没动作没对象。
  const stillVague = analyzePromptForRefine('这个');
  assert.equal(stillVague.needsClarification, true);
  assert.equal(stillVague.shouldRefine, false);
});
