// 小白办公配方构建器(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:承载 2.3 小白用户日常办公协作配方的可审批产物生成逻辑,避免 registry 变成大文件。
import { createDocxDocument, createPdfDocument, createPptxPresentation } from '../artifacts/office-writers.js';
import { createXlsxWorkbook } from '../artifacts/xlsx-writer.js';
import {
  actionRows,
  binaryOperation,
  combinedText,
  markdownOperation,
  textOperation,
  xlsxOperation,
} from './recipe-helpers.js';
import type { FileOperationInput } from '../workspace/file-operations.js';
import type { SourceLike } from './recipe-helpers.js';

type BeginnerRecipe = { id: string };

function sourceOrPromptLines(prompt: unknown, sources: SourceLike[], fallback: string): string[] {
  const promptText = String(prompt || '').trim();
  const text = combinedText(sources) || promptText || fallback;
  const lines = text
    .split(/\r?\n|[。；;]/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  return lines.length ? lines : [fallback];
}

function pickLine(lines: string[], index: number, fallback: string): string {
  return lines[index % lines.length] || fallback;
}

export function weeklyReportRecipe(trustedRoot: string, recipe: BeginnerRecipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const lines = sourceOrPromptLines(prompt, sources, '请补充本周完成事项、遇到的问题和下周计划。');
  const sections: Array<[string, string[]]> = [
    ['本周完成', [pickLine(lines, 0, '整理本周重点工作'), pickLine(lines, 1, '同步关键进展')]],
    ['重点进展', [pickLine(lines, 2, '完成阶段性输出'), pickLine(lines, 3, '推进跨部门协作')]],
    ['问题风险', [pickLine(lines, 4, '仍有事项需要确认')]],
    ['下周计划', [pickLine(lines, 5, '继续推进未完成事项'), '补齐材料后更新最终版。']],
    ['需要支持', ['请确认优先级和截止时间。']],
  ];
  const reportLines = [
    '一键周报草稿',
    `用户指令: ${prompt || '未填写'}`,
    '原文件没有被修改，审批后会另存为副本。',
    '',
    ...sections.flatMap(([title, items]) => [`## ${title}`, ...items.map((item) => `- ${item}`), '']),
  ];
  return [
    textOperation(trustedRoot, recipe.id, '一键周报草稿.txt', reportLines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, '一键周报草稿.docx', createDocxDocument({ title: '一键周报草稿', paragraphs: reportLines.filter(Boolean) })),
    binaryOperation(trustedRoot, recipe.id, '一键周报草稿.pdf', createPdfDocument({ title: '一键周报草稿', lines: reportLines })),
  ];
}

export function bossSummaryRecipe(trustedRoot: string, recipe: BeginnerRecipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const lines = sourceOrPromptLines(prompt, sources, '请补充需要向领导汇报的材料。');
  const summaryLines = [
    '给老板看的一页总结',
    `用户指令: ${prompt || '未填写'}`,
    '原文件没有被修改，审批后会另存为副本。',
    '',
    '## 结论',
    `- ${pickLine(lines, 0, '当前材料可整理为一页管理摘要。')}`,
    '## 关键依据',
    `- ${pickLine(lines, 1, '已有材料覆盖主要背景。')}`,
    `- ${pickLine(lines, 2, '仍需确认最终口径。')}`,
    '## 风险/待确认',
    `- ${pickLine(lines, 3, '部分数据或时间点需要人工复核。')}`,
    '## 下一步',
    '- 请确认是否需要改成 PPT 或正式报告。',
    '- 确认后再写入本地可信工作区。',
  ];
  return [
    textOperation(trustedRoot, recipe.id, '领导一页总结.txt', summaryLines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, '领导一页总结.docx', createDocxDocument({ title: '给老板看的一页总结', paragraphs: summaryLines.filter(Boolean) })),
    binaryOperation(trustedRoot, recipe.id, '领导一页总结.pdf', createPdfDocument({ title: '给老板看的一页总结', lines: summaryLines })),
  ];
}

function formalizeOfficeLine(line: string): string {
  return line
    .replace(/老板/g, '领导')
    .replace(/搞/g, '处理')
    .replace(/弄/g, '处理')
    .replace(/赶紧/g, '请尽快')
    .trim();
}

export function wordFormalRecipe(trustedRoot: string, recipe: BeginnerRecipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const sourceLines = sourceOrPromptLines(prompt, sources, '请补充需要改写的正文。');
  const formalLines = sourceLines.map(formalizeOfficeLine);
  const documentLines = [
    '正式文档草稿',
    `用户指令: ${prompt || '未填写'}`,
    '原文件没有被修改，审批后会另存为副本。',
    '',
    ...formalLines.map((line) => `- ${line}`),
  ];
  const noteLines = [
    '# 修改说明',
    '',
    '- 已按正式办公文风整理。',
    '- 已保留原始含义，未覆盖原文件。',
    '- 请预览确认称谓、日期、金额和专有名词。',
  ];
  return [
    textOperation(trustedRoot, recipe.id, '正式文档草稿.txt', documentLines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, '正式文档草稿.docx', createDocxDocument({ title: '正式文档草稿', paragraphs: documentLines.filter(Boolean) })),
    binaryOperation(trustedRoot, recipe.id, '正式文档草稿.pdf', createPdfDocument({ title: '正式文档草稿', lines: documentLines })),
    markdownOperation(trustedRoot, recipe.id, '修改说明.md', noteLines.join('\n')),
  ];
}

export function pptBeginnerRecipe(trustedRoot: string, recipe: BeginnerRecipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const lines = sourceOrPromptLines(prompt, sources, '请补充汇报主题和材料。');
  const title = String(prompt || '办公汇报草稿').trim() || '办公汇报草稿';
  const slides = [
    { title: '封面', bullets: [title] },
    { title: '核心结论', bullets: [pickLine(lines, 0, '先给出结论，再补充依据。')] },
    { title: '背景', bullets: [pickLine(lines, 1, '说明材料来源和当前状态。')] },
    { title: '重点内容', bullets: [pickLine(lines, 2, '列出最重要的三点内容。'), pickLine(lines, 3, '保留需要人工确认的事项。')] },
    { title: '下一步', bullets: ['请确认页数、口径和是否需要正式版。'] },
  ];
  const notes = [
    '汇报讲稿草稿',
    `用户指令: ${prompt || '未填写'}`,
    '原文件没有被修改，审批后会另存为副本。',
    '',
    ...slides.flatMap((slide) => [`## ${slide.title}`, ...slide.bullets.map((bullet) => `- ${bullet}`), '']),
  ];
  return [
    binaryOperation(trustedRoot, recipe.id, '汇报草稿.pptx', createPptxPresentation({ title, slides })),
    binaryOperation(trustedRoot, recipe.id, '汇报讲稿.docx', createDocxDocument({ title: '汇报讲稿草稿', paragraphs: notes.filter(Boolean) })),
    textOperation(trustedRoot, recipe.id, '汇报讲稿.txt', notes.join('\n')),
  ];
}

export function chatToActionListRecipe(trustedRoot: string, recipe: BeginnerRecipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const rows = actionRows(combinedText(sources), prompt);
  const lines = [
    '群聊转待办',
    `用户指令: ${prompt || '未填写'}`,
    '待确认事项:',
    ...rows.map((row) => `${row[0]}. ${row[1]} | 负责人: ${row[2]} | 截止: ${row[3]} | 状态: ${row[4]}`),
    '',
    '群消息确认草稿:',
    ...rows.map((row) => `请${row[2]}确认「${row[1]}」的截止时间是否为${row[3]}。`),
  ];
  return [
    xlsxOperation(
      trustedRoot,
      recipe.id,
      '群聊待办清单.xlsx',
      createXlsxWorkbook({ sheetName: '待办', columns: ['序号', '事项', '负责人', '截止时间', '状态'], rows }),
    ),
    textOperation(trustedRoot, recipe.id, '群消息确认草稿.txt', lines.join('\n')),
  ];
}
