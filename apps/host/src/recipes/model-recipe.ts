// 模型驱动 recipe 的产物构建层(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:在 model-recipe-extract 的结构化提取之上,把结果格式化成可审批的 office 产物,
//       并按 recipe id 注册 AI 构造器。模板做兜底:提取不到/无模型时返回 null 由调用方回退。
// 依赖:同层 model-recipe-extract(提取)、recipe-helpers、L1 artifacts(office/xlsx writers)。
// 导出:buildAiRecipeOperations / hasAiRecipeBuilder;并再导出提取层的 extract*/normalize*(供测试)。
import { combinedText, textOperation, xlsxOperation, csvOperation, binaryOperation, type SourceLike } from './recipe-helpers.js';
import { createDocxDocument, createPptxPresentation, createPdfDocument } from '../artifacts/office-writers.js';
import { createXlsxWorkbook } from '../artifacts/xlsx-writer.js';
import type { FileOperationInput } from '../workspace/file-operations.js';
import type { ModelConfig } from '../kimi/provider/types.js';
import { isEgressAuditFailure } from '../security/egress-gateway.js';
import {
  callModelForJson, extractMeetingActions, extractSummary,
  normalizeClusters, normalizeContract, normalizeWeekly, normalizeTable,
  type ModelCaller, type StructuredSummary,
} from './model-recipe-extract.js';

export * from './model-recipe-extract.js';

export type AiRecipeArgs = {
  trustedRoot: string;
  recipe: { id: string; name: string };
  sources: SourceLike[];
  prompt?: string;
  modelConfig: ModelConfig;
  modelCall?: ModelCaller;
};

const section = (label: string, items: string[]): string[] => (items.length ? [`【${label}】`, ...items.map((x) => `· ${x}`), ''] : []);
const dropDoubleBlank = (lines: string[]): string[] => lines.filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));
// 统一带上 trustedRoot:提取层据此走出站策略检查(air_gap/local_strict 等必须拦得住 AI
// recipe 的模型调用,不能因为走了 recipe 分支就绕过对话路径同款的安全闸门)并记审计。
function jsonArgs(args: AiRecipeArgs): { modelConfig: ModelConfig; modelCall?: ModelCaller; trustedRoot: string } {
  return { modelConfig: args.modelConfig, ...(args.modelCall ? { modelCall: args.modelCall } : {}), trustedRoot: args.trustedRoot };
}

function summaryLines(s: StructuredSummary, prompt: string): string[] {
  return dropDoubleBlank([
    s.title,
    prompt ? `用户指令: ${prompt}` : '',
    '',
    ...section('要点', s.keyPoints),
    ...section('风险', s.risks),
    ...section('下一步', s.nextSteps),
  ]);
}

/** 会议纪要 AI 路径:模型提取行动项 → TXT/XLSX/DOCX。提取不到返回 null(回退模板)。 */
async function buildMeetingAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  const items = await extractMeetingActions({ source, prompt: args.prompt ?? '', ...jsonArgs(args) });
  if (!items) return null;
  const lines = [
    '会议纪要行动项(AI 提取)',
    `用户指令: ${args.prompt || '未填写'}`,
    '原文件没有被修改，审批后会另存为副本。',
    '',
    ...items.map((it, i) => `${i + 1}. 【${it.owner}】${it.task}（截止：${it.due}）`),
  ];
  const rows = items.map((it, i) => [String(i + 1), it.owner, it.task, it.due]);
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, '会议行动项.txt', lines.join('\n')),
    xlsxOperation(trustedRoot, recipe.id, '会议行动项.xlsx', createXlsxWorkbook({ sheetName: '行动项', columns: ['序号', '负责人', '待办', '截止'], rows })),
    binaryOperation(trustedRoot, recipe.id, '会议纪要.docx', createDocxDocument({ title: '会议纪要行动项', paragraphs: lines })),
  ];
}

/** 总结报告 AI 路径:模型结构化摘要 → TXT/DOCX/PPTX/PDF(对齐模板产物类型)。 */
async function buildSummaryAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const s = await extractSummary({ source: combinedText(args.sources), prompt: args.prompt ?? '', ...jsonArgs(args) });
  if (!s) return null;
  const lines = summaryLines(s, args.prompt ?? '');
  const bullets = [...s.keyPoints, ...s.risks.map((x) => `风险:${x}`), ...s.nextSteps.map((x) => `下一步:${x}`)].slice(0, 12);
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: s.title, paragraphs: lines })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pptx`, createPptxPresentation({ title: s.title, slides: [{ title: s.title, bullets }] })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork Summary Report', lines })),
  ];
}

/** 给老板看的一页总结 AI 路径:复用摘要提取,一页纸 → TXT/DOCX/PDF(对齐模板类型)。 */
async function buildBossSummaryAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const s = await extractSummary({ source: combinedText(args.sources), prompt: args.prompt ?? '', ...jsonArgs(args) });
  if (!s) return null;
  const lines = summaryLines(s, args.prompt ?? '');
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: s.title, paragraphs: lines })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork One-Pager', lines })),
  ];
}

/** 反馈聚类 AI 路径:模型按主题/严重度聚合反馈并给建议动作 → TXT/DOCX(对齐模板类型)。 */
async function buildFeedbackClustersAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  if (!source.trim()) return null;
  const prompt = args.prompt ?? '';
  const parsed = await callModelForJson({
    system: '你是严谨的用户反馈分析助手。只输出 JSON,不要解释。',
    user: `把下面的用户反馈按主题聚类,输出 JSON 数组,每项 {"theme":"主题","severity":"严重度(高/中/低)","count":数量,"suggestion":"建议动作"}。只基于反馈,不编造。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n反馈:\n${source.slice(0, 8000)}`,
    ...jsonArgs(args),
  });
  const clusters = normalizeClusters(parsed);
  if (!clusters) return null;
  const lines = dropDoubleBlank([
    '用户反馈聚类(AI 提取)',
    prompt ? `用户指令: ${prompt}` : '',
    '',
    ...clusters.map((c, i) => `${i + 1}. 【${c.theme}】严重度 ${c.severity} · ${c.count} 条 → ${c.suggestion}`),
  ]);
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: '用户反馈聚类', paragraphs: lines })),
  ];
}

/** 合同摘要 AI 路径:模型提取关键条款 → TXT/DOCX/PDF(对齐模板产物类型)。 */
async function buildContractAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  if (!source.trim()) return null;
  const prompt = args.prompt ?? '';
  const parsed = await callModelForJson({
    system: '你是严谨的法务合同摘要助手。只输出 JSON,不要解释。不确定的字段写"未识别",不要编造。',
    user: `提取下面合同的关键信息,输出 JSON {"parties":"签约主体","amount":"付款/金额","term":"期限/续约","obligations":["主要义务"],"risks":["风险点"],"todos":["待确认事项"]}。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n合同:\n${source.slice(0, 8000)}`,
    ...jsonArgs(args),
  });
  const c = normalizeContract(parsed);
  if (!c) return null;
  const lines = dropDoubleBlank([
    '合同摘要(AI 提取)',
    `签约主体: ${c.parties}`,
    `付款/金额: ${c.amount}`,
    `期限/续约: ${c.term}`,
    '',
    ...section('主要义务', c.obligations),
    ...section('风险点', c.risks),
    ...section('待确认事项', c.todos),
  ]);
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: '合同摘要', paragraphs: lines })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork Contract Summary', lines })),
  ];
}

/** 一键周报 AI 路径:模型结构化整理本周流水账 → TXT/DOCX/PDF(对齐模板类型)。 */
async function buildWeeklyReportAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  const prompt = args.prompt ?? '';
  if (!source.trim() && !prompt.trim()) return null;
  const parsed = await callModelForJson({
    system: '你是严谨的周报助手。只输出 JSON,不要解释或 markdown。',
    user: `把下面的本周流水账/材料整理成正式周报,输出 JSON {"title":"标题","done":["本周完成"],"doing":["进行中"],"next":["下周计划"],"risks":["风险/阻塞"]}。只基于材料,不编造。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n材料:\n${(source || prompt).slice(0, 8000)}`,
    ...jsonArgs(args),
  });
  const w = normalizeWeekly(parsed);
  if (!w) return null;
  const lines = dropDoubleBlank([
    w.title,
    prompt ? `用户指令: ${prompt}` : '',
    '',
    ...section('本周完成', w.done),
    ...section('进行中', w.doing),
    ...section('下周计划', w.next),
    ...section('风险/阻塞', w.risks),
  ]);
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: w.title, paragraphs: lines })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork Weekly Report', lines })),
  ];
}

/** 表格清洗 AI 路径:模型清洗/规整脏表格 → TXT/XLSX/CSV/DOCX(对齐模板类型)。 */
async function buildExcelCleaningAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  if (!source.trim()) return null;
  const prompt = args.prompt ?? '';
  const parsed = await callModelForJson({
    system: '你是严谨的数据清洗助手。只输出 JSON,不要解释。保留真实数据,不编造行。',
    user: `清洗下面的表格数据:去除空白行、统一每列格式、对齐列数、标记疑似重复或缺失。输出 JSON {"columns":["列名"],"rows":[["单元格"]],"issues":["发现的问题说明"]}。rows 每行长度必须等于 columns 数。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n表格:\n${source.slice(0, 8000)}`,
    ...jsonArgs(args),
  });
  const t = normalizeTable(parsed);
  if (!t) return null;
  const lines = [
    '表格清洗结论(AI 提取)',
    prompt ? `用户指令: ${prompt}` : '',
    `清洗后列数: ${t.columns.length} · 行数: ${t.rows.length}`,
    t.issues.length ? `需人工确认: ${t.issues.length}` : '未发现明显问题',
    '原始文件没有被修改，结果会另存为副本。',
    ...(t.issues.length ? ['', '【发现的问题】', ...t.issues.map((x) => `· ${x}`)] : []),
  ].filter(Boolean);
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, '表格清洗结论.txt', lines.join('\n')),
    xlsxOperation(trustedRoot, recipe.id, '清洗结果.xlsx', createXlsxWorkbook({ sheetName: '清洗结果', columns: t.columns, rows: t.rows })),
    csvOperation(trustedRoot, recipe.id, '清洗结果.csv', [t.columns, ...t.rows]),
    binaryOperation(trustedRoot, recipe.id, '表格清洗报告.docx', createDocxDocument({ title: '表格清洗报告', paragraphs: lines })),
  ];
}

// recipe id → AI 构造器。有模型且命中时用 AI,否则调用方回退模板。
const AI_RECIPE_BUILDERS: Record<string, (args: AiRecipeArgs) => Promise<FileOperationInput[] | null>> = {
  'meeting-actions': buildMeetingAiOperations,
  'summary-report': buildSummaryAiOperations,
  'contract-summary': buildContractAiOperations,
  'boss-summary-onepager': buildBossSummaryAiOperations,
  'feedback-clusters': buildFeedbackClustersAiOperations,
  'weekly-report-beginner': buildWeeklyReportAiOperations,
  'excel-cleaning': buildExcelCleaningAiOperations,
  'excel-rescue-basic': buildExcelCleaningAiOperations,
};

export function hasAiRecipeBuilder(recipeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_RECIPE_BUILDERS, recipeId);
}

/** 有模型配置且该 recipe 有 AI 路径时,产出 AI operations;否则返回 null(回退模板)。 */
export async function buildAiRecipeOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  if (!args.modelConfig) return null;
  const builder = AI_RECIPE_BUILDERS[args.recipe.id];
  if (!builder) return null;
  try {
    return await builder(args);
  } catch (error) {
    if (isEgressAuditFailure(error)) throw error;
    return null;
  }
}
