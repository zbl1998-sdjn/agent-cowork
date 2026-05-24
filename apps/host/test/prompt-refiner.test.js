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

test('refine policy skips already explicit prompts', () => {
  const result = analyzePromptForRefine('请审查 apps/host/src/server.js 的鉴权逻辑并列出高风险问题');
  assert.equal(result.explicit, true);
  assert.equal(result.shouldRefine, false);
  assert.deepEqual(result.missing, []);
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
