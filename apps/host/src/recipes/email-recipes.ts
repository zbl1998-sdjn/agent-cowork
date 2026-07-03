// 邮件配方(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:生成本地优先的邮件草稿、主题建议和复制前检查清单。只产出可审批文件,不连接邮箱、不自动发送。
import { createDocxDocument } from '../artifacts/office-writers.js';
import {
  binaryOperation,
  combinedText,
  sourceBlock,
  textOperation,
} from './recipe-helpers.js';
import type { FileOperationInput } from '../workspace/file-operations.js';
import type { SourceLike } from './recipe-helpers.js';

type EmailRecipe = { id: string };

function linesFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function compactTopic(promptText: string, sourceText: string): string {
  const seed = (promptText || sourceText || '这件事')
    .split(/\r?\n/)
    .map((line) => line.replace(/[。！？!?,，；;：:]/g, ' ').trim())
    .find(Boolean) || '这件事';
  return seed.slice(0, 28);
}

function emailIntent(promptText: string): 'reply' | 'follow-up' | 'polish' | 'compose' {
  if (/回复|回信|respond|reply/i.test(promptText)) return 'reply';
  if (/跟进|催|提醒|follow.?up/i.test(promptText)) return 'follow-up';
  if (/润色|改写|语法|检查|proof|polish|grammar/i.test(promptText)) return 'polish';
  return 'compose';
}

function subjectSuggestions(topic: string, intent: ReturnType<typeof emailIntent>): string[] {
  if (intent === 'reply') {
    return [`回复：${topic}`, `关于${topic}的确认`, `${topic}后续安排`];
  }
  if (intent === 'follow-up') {
    return [`跟进：${topic}`, `请确认：${topic}`, `${topic}进展同步`];
  }
  if (intent === 'polish') {
    return [`关于${topic}的说明`, `${topic}沟通稿`, `${topic}确认邮件`];
  }
  return [`关于${topic}`, `${topic}沟通确认`, `${topic}下一步安排`];
}

function closingForIntent(intent: ReturnType<typeof emailIntent>): string {
  if (intent === 'follow-up') return '方便时请帮忙确认一下当前进展。如需我补充材料,请直接告诉我。';
  if (intent === 'reply') return '以上是我的确认和补充,如有遗漏请提醒我。';
  if (intent === 'polish') return '请确认语气和事实是否准确,确认后再复制发送。';
  return '如果这个方向可以,我会按邮件内容继续推进下一步。';
}

export function emailDraftRecipe(
  trustedRoot: string,
  recipe: EmailRecipe,
  prompt: unknown,
  sources: SourceLike[],
): FileOperationInput[] {
  const promptText = String(prompt || '').trim();
  const sourceText = combinedText(sources);
  const topic = compactTopic(promptText, sourceText);
  const intent = emailIntent(promptText);
  const facts = linesFromText(sourceText || promptText);
  const subjects = subjectSuggestions(topic, intent);
  const bodyLines = [
    '您好,',
    '',
    intent === 'polish'
      ? '我把原始内容整理成更清晰、礼貌、适合直接发送的版本如下。'
      : `我想就“${topic}”和您同步一下。`,
    '',
    '关键信息:',
    ...(facts.length ? facts.map((line) => `- ${line}`) : ['- 需要补充收件人、背景和希望对方采取的动作。']),
    '',
    closingForIntent(intent),
    '',
    '谢谢。',
  ];
  const text = [
    '# 邮件草稿',
    '',
    '## 主题建议',
    ...subjects.map((subject, index) => `${index + 1}. ${subject}`),
    '',
    '## 可复制邮件正文',
    ...bodyLines,
    '',
    '## 发送前检查',
    '- 收件人、称呼、事实和日期已人工确认。',
    '- 附件如需发送,已人工检查文件名和版本。',
    '- 系统只生成草稿,不会自动连接邮箱或发送。',
    '',
    '## 来源',
    sourceBlock(sources),
    '',
  ].join('\n');

  return [
    textOperation(trustedRoot, recipe.id, '邮件草稿.txt', text),
    binaryOperation(
      trustedRoot,
      recipe.id,
      '邮件草稿.docx',
      createDocxDocument({ title: '邮件草稿', paragraphs: [...subjects, ...bodyLines] }),
    ),
  ];
}
