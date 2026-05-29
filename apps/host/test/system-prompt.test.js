import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEnvBlock, buildSystemPrompt, SYSTEM_PROMPT_VERSION } from '../src/kimi/system-prompt.js';

const fixedNow = new Date('2026-05-28T01:23:00Z');

test('buildEnvBlock renders today + working dir + OS + app version + model', () => {
  const lines = buildEnvBlock({
    now: fixedNow,
    trustedRoot: 'C:/work',
    osName: 'Windows',
    appVersion: '0.2.0',
    provider: 'kimi-api',
    model: 'kimi-k2-0905-preview',
  });
  const block = lines.join('\n');
  assert.match(block, /<env>/);
  assert.match(block, /<\/env>/);
  assert.match(block, /今天:2026-05-28/);
  assert.match(block, /星期/);
  assert.match(block, /工作目录:C:\/work/);
  assert.match(block, /操作系统:Windows/);
  assert.match(block, /应用版本:Agent Cowork v0\.2\.0/);
  assert.match(block, /当前模型:kimi-api \/ kimi-k2-0905-preview/);
  assert.match(block, /真实世界的当前时间/);
});

test('buildEnvBlock omits optional fields when blank', () => {
  const block = buildEnvBlock({ now: fixedNow }).join('\n');
  assert.match(block, /<env>/);
  assert.match(block, /今天:/);
  assert.doesNotMatch(block, /工作目录:/);
  assert.doesNotMatch(block, /操作系统:/);
  assert.doesNotMatch(block, /应用版本:/);
  assert.doesNotMatch(block, /当前模型:/);
});

test('buildSystemPrompt puts the env block at the very TOP', () => {
  const prompt = buildSystemPrompt({
    env: { now: fixedNow, trustedRoot: 'C:/work', osName: 'Windows' },
  });
  // The first line should be the <env> opener — anything earlier defeats the
  // purpose (compactors and middle-of-window attention dropoffs would lose it).
  assert.equal(prompt.split('\n')[0], '<env>');
  // And the legacy "你是 Agent Cowork" preamble must come AFTER the env block.
  const envEndIdx = prompt.indexOf('</env>');
  const preambleIdx = prompt.indexOf('你是 Agent Cowork');
  assert.ok(envEndIdx > 0 && preambleIdx > envEndIdx, 'preamble must follow </env>');
});

test('SYSTEM_PROMPT_VERSION bumped to v2 (env block addition)', () => {
  assert.equal(SYSTEM_PROMPT_VERSION, 'agent-system-prompt-v2');
});

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
