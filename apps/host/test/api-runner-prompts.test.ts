import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKimiApiChatPrompt,
  buildKimiApiPlanPrompt,
} from '../src/kimi/api-runner.js';

test('buildKimiApiPlanPrompt constrains API plan output', () => {
  const prompt = buildKimiApiPlanPrompt({
    mode: 'code',
    summary: '合同草稿包含 renewal date。',
    prompt: '生成整理计划',
    memory: '偏好：先列风险。',
  });

  assert.match(prompt, /工作区记忆/);
  assert.match(prompt, /只基于下面摘要回答/);
  assert.match(prompt, /不要修改文件/);
  assert.match(prompt, /不要使用工具/);
  assert.match(prompt, /模式：code/);
  assert.match(prompt, /renewal date/);
  assert.match(prompt, /生成整理计划/);
});

test('buildKimiApiChatPrompt is conversational (no forced file-planning)', () => {
  const prompt = buildKimiApiChatPrompt({
    summary: '已上传 invoice.pdf。',
    prompt: '这个文件能做什么？',
  });

  assert.match(prompt, /智能助手/);
  assert.match(prompt, /自然的中文/);
  assert.match(prompt, /不要生成/);
  assert.match(prompt, /invoice\.pdf/);
  assert.match(prompt, /这个文件能做什么/);
});
