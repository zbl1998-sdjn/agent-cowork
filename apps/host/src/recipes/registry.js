import { createDocxDocument, createPdfDocument, createPptxPresentation } from '../artifacts/office-writers.js';
import { createXlsxWorkbook } from '../artifacts/xlsx-writer.js';
import {
  actionRows,
  binaryOperation,
  combinedText,
  csvOperation,
  markdownOperation,
  parseTableRows,
  reimbursementRows,
  sourceBlock,
  xlsxOperation,
} from './recipe-helpers.js';

/**
 * @typedef {import('../workspace/file-operations.js').FileOperationInput} FileOperationInput
 * @typedef {import('./recipe-helpers.js').SourceLike} SourceLike
 * @typedef {{ id: string, name: string, description: string, output: string, riskLevel: string, custom?: boolean, [key: string]: unknown }} Recipe
 * @typedef {{ recipeId?: string, trustedRoot?: string, prompt?: unknown, sources?: SourceLike[], recipe?: Recipe | null }} BuildRecipeOptions
 */

/** @type {[string, string, string, string, string][]} */
const RECIPE_ROWS = [
  ['meeting-actions', '会议纪要转行动项', '从会议记录中提取结论、负责人、截止时间和待办清单。', 'Markdown + XLSX', 'safe-write'],
  ['excel-cleaning', '表格清洗', '读取 CSV/XLSX，去空行、标记重复和缺失字段，生成清洗结果。', 'Markdown + XLSX', 'safe-write'],
  ['reimbursement', '报销材料整理', '汇总发票、金额、供应商和缺失材料，生成报销清单。', 'CSV + Markdown', 'safe-write'],
  ['folder-organize', '文件夹整理', '按类型和主题生成整理建议，默认只写计划不移动原文件。', 'Markdown', 'preview-only'],
  ['contract-summary', '合同摘要', '提取合同主体、付款、续约、风险点和待确认事项。', 'Markdown', 'safe-write'],
  ['feedback-clusters', '反馈聚类', '把用户反馈按主题、严重度和建议动作聚合。', 'Markdown', 'safe-write'],
  ['summary-report', '总结报告', '把本地材料整理成结构化周报、项目总结或管理摘要。', 'Markdown + DOCX + PPTX + PDF', 'safe-write'],
  ['email-draft', '邮件草稿', '基于本地上下文生成中文商务邮件草稿和附件清单。', 'Markdown', 'safe-write'],
];

/** @type {Recipe[]} */
const RECIPES = RECIPE_ROWS.map(([id, name, description, output, riskLevel]) => ({
  id,
  name,
  description,
  output,
  riskLevel,
}));

/** @param {Recipe} recipe @param {unknown} prompt @param {SourceLike[]} sources @returns {string} */
function genericMarkdown(recipe, prompt, sources) {
  const text = combinedText(sources);
  const excerpt = text ? text.slice(0, 2000) : '暂无可读取正文。';
  return [
    `# ${recipe.name}`,
    '',
    `- 用户指令: ${prompt || '未填写'}`,
    `- 模板: ${recipe.id}`,
    `- 输出类型: ${recipe.output}`,
    '',
    '## 来源',
    sourceBlock(sources),
    '',
    '## 来源摘要',
    excerpt,
    '',
    '## 处理结果',
    excerpt,
    '',
    '## 下一步',
    '- 请确认来源是否完整。',
    '- 审批后该产物会写入本地可信工作区。',
    '',
  ].join('\n');
}

/** @param {string} trustedRoot @param {Recipe} recipe @param {unknown} prompt @param {SourceLike[]} sources @returns {FileOperationInput[]} */
function meetingRecipe(trustedRoot, recipe, prompt, sources) {
  const text = combinedText(sources);
  const rows = actionRows(text, prompt);
  return [
    markdownOperation(
      trustedRoot,
      recipe.id,
      '会议行动项.md',
      [
        '# 会议纪要行动项',
        '',
        `- 用户指令: ${prompt || '未填写'}`,
        '',
        '## 来源',
        sourceBlock(sources),
        '',
        '## 行动项',
        ...rows.map((row) => `- ${row[1]} | 负责人: ${row[2]} | 截止: ${row[3]} | 状态: ${row[4]}`),
        '',
      ].join('\n'),
    ),
    xlsxOperation(
      trustedRoot,
      recipe.id,
      '会议行动项.xlsx',
      createXlsxWorkbook({
        sheetName: '行动项',
        columns: ['序号', '行动项', '负责人', '截止时间', '状态'],
        rows,
      }),
    ),
  ];
}

/** @param {string} trustedRoot @param {Recipe} recipe @param {unknown} prompt @param {SourceLike[]} sources @returns {FileOperationInput[]} */
function excelRecipe(trustedRoot, recipe, prompt, sources) {
  const parsed = parseTableRows(combinedText(sources));
  const issueCount = parsed.rows.filter((row) => row[row.length - 1] !== '正常').length;
  return [
    markdownOperation(
      trustedRoot,
      recipe.id,
      '表格清洗报告.md',
      [
        '# 表格清洗报告',
        '',
        `- 用户指令: ${prompt || '未填写'}`,
        `- 清洗后行数: ${parsed.rows.length}`,
        `- 需人工确认: ${issueCount}`,
        '',
        '## 来源',
        sourceBlock(sources),
        '',
        '## 规则',
        '- 去除空白行。',
        '- 标记疑似重复行。',
        '- 标记存在空字段的行。',
        '',
      ].join('\n'),
    ),
    xlsxOperation(
      trustedRoot,
      recipe.id,
      '清洗结果.xlsx',
      createXlsxWorkbook({
        sheetName: '清洗结果',
        columns: parsed.columns,
        rows: parsed.rows,
      }),
    ),
  ];
}

/** @param {string} trustedRoot @param {Recipe} recipe @param {unknown} prompt @param {SourceLike[]} sources @returns {FileOperationInput[]} */
function reimbursementRecipe(trustedRoot, recipe, prompt, sources) {
  const rows = reimbursementRows(combinedText(sources));
  return [
    csvOperation(trustedRoot, recipe.id, '报销清单.csv', [['序号', '供应商/项目', '金额', '状态', '来源摘录'], ...rows]),
    markdownOperation(
      trustedRoot,
      recipe.id,
      '报销材料核验.md',
      [
        '# 报销材料核验',
        '',
        `- 用户指令: ${prompt || '未填写'}`,
        `- 条目数: ${rows.length}`,
        '',
        '## 来源',
        sourceBlock(sources),
        '',
        '## 缺失项',
        ...rows.filter((row) => row[3] !== '待核验发票').map((row) => `- ${row[1]}: ${row[3]}`),
        '',
      ].join('\n'),
    ),
  ];
}

/** @param {string} trustedRoot @param {Recipe} recipe @param {unknown} prompt @param {SourceLike[]} sources @returns {FileOperationInput[]} */
function summaryReportRecipe(trustedRoot, recipe, prompt, sources) {
  const markdown = genericMarkdown(recipe, prompt, sources);
  const text = combinedText(sources);
  const promptText = String(prompt || '');
  const bullets = (text || promptText || '请确认来源是否完整')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const title = promptText || recipe.name;
  return [
    markdownOperation(trustedRoot, recipe.id, `${recipe.name}.md`, markdown),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title, paragraphs: bullets })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pptx`, createPptxPresentation({ title, slides: [{ title, bullets }] })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork Summary Report', lines: [promptText, ...bullets] })),
  ];
}

/** @returns {Recipe[]} */
export function listRecipes() {
  return RECIPES.map((recipe) => ({ ...recipe }));
}

/** @param {string} recipeId @returns {Recipe | null} */
export function getRecipe(recipeId) {
  return RECIPES.find((recipe) => recipe.id === recipeId) || null;
}

/** @param {BuildRecipeOptions} [options] @returns {FileOperationInput[]} */
export function buildRecipeOperations({ recipeId, trustedRoot, prompt = '', sources = [], recipe: providedRecipe = null } = {}) {
  const id = typeof recipeId === 'string' ? recipeId : '';
  const root = typeof trustedRoot === 'string' ? trustedRoot : '';
  const recipe = providedRecipe || getRecipe(id);
  if (!recipe) {
    throw new Error(`Unknown recipe: ${recipeId}`);
  }
  if (recipe.id === 'meeting-actions') {
    return meetingRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'excel-cleaning') {
    return excelRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'reimbursement') {
    return reimbursementRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'summary-report') {
    return summaryReportRecipe(root, recipe, prompt, sources);
  }
  return [markdownOperation(root, recipe.id, `${recipe.name}.md`, genericMarkdown(recipe, prompt, sources))];
}
