import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../src/kimi/system-prompt.js';

test('developer mode system prompt includes code-work constraints', () => {
  const prompt = buildSystemPrompt({ developerMode: true });
  assert.match(prompt, /【开发者模式】/);
  assert.match(prompt, /简短计划/);
  assert.match(prompt, /dirty tree/);
  assert.match(prompt, /保留他人已有改动/);
  assert.match(prompt, /聚焦验证/);
  assert.match(prompt, /GitCommit/);
  assert.match(prompt, /不能静默提交/);
});

test('default system prompt advertises git read-only and commit risk boundaries', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /GitStatus\/GitDiff\/GitLog 是只读 git 工具/);
  assert.match(prompt, /GitCommit 会创建提交/);
  assert.match(prompt, /高风险变更/);
});

test('default system prompt keeps answer style and follow-up suggestions explicit', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /简洁、自然的中文总结/);
  assert.match(prompt, /```suggestions/);
  assert.match(prompt, /2-3 个用户可能想做的后续动作/);
});
