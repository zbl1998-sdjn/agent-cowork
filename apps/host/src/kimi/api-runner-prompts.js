import { cleanText, MAX_PROMPT_LENGTH } from './api-runner-config.js';

function buildMemoryBlock(memory) {
  const text = cleanText(memory).slice(0, 4096);
  if (!text) {
    return '';
  }
  return [
    '工作区记忆 (.AgentCowork/MEMORY.md, 用户已确认的长期事实, 严格遵守):',
    text,
    '工作区记忆结束。',
  ].join('\n');
}

export function buildKimiApiPlanPrompt({ prompt, summary = '', mode = 'cowork', memory = '' }) {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines = [];
  if (memoryBlock) {
    lines.push(memoryBlock);
  }
  lines.push(
    '只基于下面摘要回答，不要读取文件，不要使用工具，不要修改文件，不要运行命令。',
    '用中文 Markdown 输出：目标理解、三条整理建议、审批前本地动作清单。',
    `模式：${mode === 'code' ? 'code' : 'cowork'}`,
    `摘要：${safeSummary || '暂无。'}`,
    `用户指令：${userPrompt}`,
  );
  return lines.join('\n');
}

export function buildKimiApiChatPrompt({ prompt, summary = '', memory = '' }) {
  const userPrompt = cleanText(prompt);
  if (!userPrompt) {
    throw new Error('prompt is required');
  }
  if (userPrompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt is too long; max ${MAX_PROMPT_LENGTH} characters`);
  }

  const safeSummary = cleanText(summary).slice(0, 2400);
  const memoryBlock = buildMemoryBlock(memory);
  const lines = [];
  if (memoryBlock) {
    lines.push(memoryBlock);
  }
  lines.push('你是 Agent Cowork 的智能助手，用简洁、自然的中文与用户对话，像同事一样直接回答问题，不要套话。');
  lines.push('日常聊天无需读写文件，也不要生成“执行计划/待审批操作”；只有当用户明确要整理或处理本地文件时，再提示可在左侧选择对应模板。');
  if (safeSummary) lines.push(`参考摘要：${safeSummary}`);
  lines.push(`用户：${userPrompt}`);
  return lines.join('\n');
}
