// 配方注册表(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:内置「一键配方」(会议纪要转行动项、表格清洗、报销整理、合同摘要、总结报告等)的清单与
//       产物构建。每个配方把来源材料加工成「可审批的文件操作(write)」,经审批后落入工作区。
//       配方各 description 是面向用户的运行时中文字符串(非注释)。
// 依赖:artifacts/office-writers·xlsx-writer + 同层 recipe-helpers。
// 导出:listRecipes / getRecipe / buildRecipeOperations。
import { createDocxDocument, createPdfDocument, createPptxPresentation } from '../artifacts/office-writers.js';
import { createXlsxWorkbook } from '../artifacts/xlsx-writer.js';
import {
  bossSummaryRecipe,
  chatToActionListRecipe,
  pptBeginnerRecipe,
  weeklyReportRecipe,
  wordFormalRecipe,
} from './beginner-office-recipes.js';
import { emailDraftRecipe } from './email-recipes.js';
import {
  actionRows,
  binaryOperation,
  combinedText,
  csvOperation,
  markdownOperation,
  parseTableRows,
  reimbursementRows,
  sourceBlock,
  textOperation,
  xlsxOperation,
} from './recipe-helpers.js';
import type { FileOperationInput } from '../workspace/file-operations.js';
import type { SourceLike } from './recipe-helpers.js';

export type Recipe = {
  id: string;
  name: string;
  description: string;
  output: string;
  riskLevel: string;
  /** 是否必须有可用来源材料才允许产出:true 时 0 可用来源会被 run-recipe 422 熔断(grounded 原则,防空壳交付物)。 */
  requiresSources?: boolean;
  custom?: boolean;
  [key: string]: unknown;
};

export type BuildRecipeOptions = {
  recipeId?: string;
  trustedRoot?: string;
  prompt?: unknown;
  sources?: SourceLike[];
  recipe?: Recipe | null;
};

// 第六列 requiresSources:转换型配方(从既有材料提取/加工)必须有真实来源;
// 生成型配方(folder-organize 看工作区、email-draft 可凭指令起草)允许无引用文件。
const RECIPE_ROWS: [string, string, string, string, string, boolean][] = [
  ['meeting-actions', '会议纪要转行动项', '从会议记录中提取结论、负责人、截止时间和待办清单。', 'DOCX + XLSX + TXT', 'safe-write', true],
  ['excel-cleaning', '表格清洗', '读取 CSV/XLSX，去空行、标记重复和缺失字段，生成清洗结果。', 'XLSX + CSV + DOCX + TXT', 'safe-write', true],
  ['reimbursement', '报销材料整理', '汇总发票、金额、供应商和缺失材料，生成报销清单。', 'XLSX + CSV + DOCX + TXT', 'safe-write', true],
  ['folder-organize', '文件夹整理', '按类型和主题生成整理建议，默认只写计划不移动原文件。', 'DOCX + TXT', 'preview-only', false],
  ['contract-summary', '合同摘要', '提取合同主体、付款、续约、风险点和待确认事项。', 'DOCX + PDF + TXT', 'safe-write', true],
  ['feedback-clusters', '反馈聚类', '把用户反馈按主题、严重度和建议动作聚合。', 'DOCX + TXT', 'safe-write', true],
  ['summary-report', '总结报告', '把本地材料整理成结构化周报、项目总结或管理摘要。', 'DOCX + PPTX + PDF + TXT', 'safe-write', true],
  ['email-draft', '邮件草稿', '基于本地上下文生成中文商务邮件草稿和附件清单。', 'DOCX + TXT', 'safe-write', false],
  ['boss-summary-onepager', '给老板看的一页总结', '把多份材料提炼成一页领导摘要、风险和下一步。', 'DOCX + PDF + TXT', 'safe-write', false],
  ['weekly-report-beginner', '一键周报', '把本周流水账或材料整理成正式周报和可复制文本。', 'DOCX + PDF + TXT', 'safe-write', false],
  ['excel-rescue-basic', '表格急救', '检查重复、空值、异常和格式问题，生成清洗副本与文字结论。', 'XLSX + CSV + DOCX + TXT', 'safe-write', true],
  ['word-make-formal', 'Word 改正式', '把口语、通知或说明整理成正式文档，并生成修改说明。', 'DOCX + PDF + TXT + MD', 'safe-write', false],
  ['ppt-from-folder-beginner', '文件夹生成PPT', '从材料生成汇报故事线、PPTX 和讲稿草稿。', 'PPTX + DOCX + TXT', 'safe-write', false],
  ['chat-to-action-list', '群聊转待办', '从聊天记录提炼事项、负责人、截止时间和群消息草稿。', 'XLSX + TXT', 'safe-write', true],
];

const RECIPES: Recipe[] = RECIPE_ROWS.map(([id, name, description, output, riskLevel, requiresSources]) => ({
  id,
  name,
  description,
  output,
  riskLevel,
  requiresSources,
}));

function customMarkdownFormat(recipe: Recipe, prompt: unknown, sources: SourceLike[]): string | null {
  const format = recipe.format && typeof recipe.format === 'object' && !Array.isArray(recipe.format)
    ? recipe.format as { kind?: unknown; body?: unknown }
    : null;
  if (!recipe.custom || format?.kind !== 'markdown' || typeof format.body !== 'string') {
    return null;
  }
  const text = combinedText(sources);
  const excerpt = text ? text.slice(0, 2000) : '暂无可读取正文。';
  const replacements: Record<string, string> = {
    '{{recipe.name}}': recipe.name,
    '{{recipe.description}}': recipe.description || '',
    '{{recipe.id}}': recipe.id,
    '{{prompt}}': String(prompt || recipe.prompt || ''),
    '{{sources}}': sourceBlock(sources),
    '{{source_excerpt}}': excerpt,
    '{{generated_at}}': new Date().toISOString(),
  };
  return Object.entries(replacements).reduce(
    (content, [placeholder, value]) => content.split(placeholder).join(value),
    format.body,
  );
}

function genericMarkdown(recipe: Recipe, prompt: unknown, sources: SourceLike[]): string {
  const customMarkdown = customMarkdownFormat(recipe, prompt, sources);
  if (customMarkdown) {
    return customMarkdown;
  }
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

function genericOfficeText(recipe: Recipe, prompt: unknown, sources: SourceLike[]): string {
  return genericMarkdown(recipe, prompt, sources)
    .replace(/^# /gm, '')
    .replace(/^## /gm, '')
    .replace(/^- /gm, '- ');
}

function genericOfficeOperations(trustedRoot: string, recipe: Recipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const text = genericOfficeText(recipe, prompt, sources);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 24);
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, text),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: recipe.name, paragraphs: lines })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: recipe.name, lines })),
  ];
}

function meetingRecipe(trustedRoot: string, recipe: Recipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const text = combinedText(sources);
  const rows = actionRows(text, prompt);
  const lines = [
    '会议纪要行动项',
    `用户指令: ${prompt || '未填写'}`,
    '来源:',
    sourceBlock(sources),
    '行动项:',
    ...rows.map((row) => `${row[0]}. ${row[1]} | 负责人: ${row[2]} | 截止: ${row[3]} | 状态: ${row[4]}`),
  ];
  return [
    textOperation(
      trustedRoot,
      recipe.id,
      '会议行动项.txt',
      lines.join('\n'),
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
    binaryOperation(trustedRoot, recipe.id, '会议纪要.docx', createDocxDocument({ title: '会议纪要行动项', paragraphs: lines.slice(1) })),
  ];
}

function excelRecipe(trustedRoot: string, recipe: Recipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const parsed = parseTableRows(combinedText(sources));
  const issueCount = parsed.rows.filter((row) => row[row.length - 1] !== '正常').length;
  const summaryLines = [
    '表格清洗结论',
    `用户指令: ${prompt || '未填写'}`,
    `清洗后行数: ${parsed.rows.length}`,
    `需人工确认: ${issueCount}`,
    '处理规则: 去除空白行、标记疑似重复、标记空字段。',
    '原始文件没有被修改，结果会另存为副本。',
  ];
  return [
    textOperation(trustedRoot, recipe.id, '表格清洗结论.txt', summaryLines.join('\n')),
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
    csvOperation(trustedRoot, recipe.id, '清洗结果.csv', [parsed.columns, ...parsed.rows]),
    binaryOperation(trustedRoot, recipe.id, '表格清洗报告.docx', createDocxDocument({ title: '表格清洗报告', paragraphs: summaryLines.slice(1) })),
  ];
}

function reimbursementRecipe(trustedRoot: string, recipe: Recipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const rows = reimbursementRows(combinedText(sources));
  const columns = ['序号', '供应商/项目', '金额', '状态', '来源摘录'];
  const lines = [
    '报销材料核验',
    `用户指令: ${prompt || '未填写'}`,
    `条目数: ${rows.length}`,
    '缺失项:',
    ...rows.filter((row) => row[3] !== '待核验发票').map((row) => `${row[1]}: ${row[3]}`),
  ];
  return [
    csvOperation(trustedRoot, recipe.id, '报销清单.csv', [columns, ...rows]),
    xlsxOperation(
      trustedRoot,
      recipe.id,
      '报销清单.xlsx',
      createXlsxWorkbook({ sheetName: '报销清单', columns, rows }),
    ),
    textOperation(trustedRoot, recipe.id, '报销材料核验.txt', lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, '报销材料核验.docx', createDocxDocument({ title: '报销材料核验', paragraphs: lines.slice(1) })),
  ];
}


function summaryReportRecipe(trustedRoot: string, recipe: Recipe, prompt: unknown, sources: SourceLike[]): FileOperationInput[] {
  const textReport = genericOfficeText(recipe, prompt, sources);
  const text = combinedText(sources);
  const promptText = String(prompt || '');
  const bullets = (text || promptText || '请确认来源是否完整')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const title = promptText || recipe.name;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, textReport),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title, paragraphs: bullets })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pptx`, createPptxPresentation({ title, slides: [{ title, bullets }] })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork Summary Report', lines: [promptText, ...bullets] })),
  ];
}

/** 列出全部内置配方(浅拷贝,不泄露内部引用)。 */
export function listRecipes(): Recipe[] {
  return RECIPES.map((recipe) => ({ ...recipe }));
}

/** 按 id 取配方,不存在返回 null。 */
export function getRecipe(recipeId: string): Recipe | null {
  return RECIPES.find((recipe) => recipe.id === recipeId) || null;
}

/** 据配方 id 把来源材料构建成「可审批的文件操作」数组(各配方有专属构建器,其余走通用办公格式)。 */
export function buildRecipeOperations({ recipeId, trustedRoot, prompt = '', sources = [], recipe: providedRecipe = null }: BuildRecipeOptions = {}): FileOperationInput[] {
  const id = typeof recipeId === 'string' ? recipeId : '';
  const root = typeof trustedRoot === 'string' ? trustedRoot : '';
  const recipe = providedRecipe || getRecipe(id);
  if (!recipe) {
    throw new Error(`Unknown recipe: ${recipeId}`);
  }
  if (recipe.id === 'meeting-actions') {
    return meetingRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'excel-cleaning' || recipe.id === 'excel-rescue-basic') {
    return excelRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'reimbursement') {
    return reimbursementRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'summary-report') {
    return summaryReportRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'weekly-report-beginner') {
    return weeklyReportRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'email-draft') {
    return emailDraftRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'boss-summary-onepager') {
    return bossSummaryRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'word-make-formal') {
    return wordFormalRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'ppt-from-folder-beginner') {
    return pptBeginnerRecipe(root, recipe, prompt, sources);
  }
  if (recipe.id === 'chat-to-action-list') {
    return chatToActionListRecipe(root, recipe, prompt, sources);
  }
  if (recipe.custom) {
    const customMarkdown = customMarkdownFormat(recipe, prompt, sources);
    if (customMarkdown) return [markdownOperation(root, recipe.id, `${recipe.name}.md`, customMarkdown)];
  }
  return genericOfficeOperations(root, recipe, prompt, sources);
}
