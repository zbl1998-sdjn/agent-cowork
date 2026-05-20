import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildKimiCliPlanArgs, buildKimiPlanPrompt } from '../src/kimi/cli-runner.js';

test('buildKimiPlanPrompt constrains Kimi CLI to plan-only output', () => {
  const prompt = buildKimiPlanPrompt({
    mode: 'code',
    summary: '合同草稿包含 renewal date。',
    prompt: '生成整理计划',
  });

  assert.match(prompt, /只基于下面摘要回答/);
  assert.match(prompt, /不要修改文件/);
  assert.match(prompt, /不要使用工具/);
  assert.match(prompt, /模式：code/);
  assert.match(prompt, /renewal date/);
  assert.match(prompt, /生成整理计划/);
});

test('buildKimiCliPlanArgs uses non-interactive plan mode with trusted root', () => {
  const args = buildKimiCliPlanArgs({
    trustedRoot: 'C:\\workspace',
    prompt: '列出计划',
    summary: '本地摘要',
    mode: 'cowork',
    maxSteps: 2,
    model: 'kimi-test',
  });

  assert.deepEqual(args.slice(0, 7), [
    '--work-dir',
    'C:\\workspace',
    '--print',
    '--final-message-only',
    '--max-steps-per-turn',
    '2',
    '--model',
  ]);
  assert.equal(args[7], 'kimi-test');
  assert.equal(args[8], '--prompt');
  assert.match(args[9], /本地摘要/);
});

test('buildKimiCliPlanArgs rejects empty prompts', () => {
  assert.throws(
    () => buildKimiCliPlanArgs({ trustedRoot: 'C:\\workspace', prompt: '   ' }),
    /prompt is required/,
  );
});
