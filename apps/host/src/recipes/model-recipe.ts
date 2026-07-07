// 模型驱动的 recipe 提取(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:把 recipe 的源材料交给已配置的模型(Ollama/Kimi 等)做「结构化提取」,
//       返回可被 office-writers 格式化的结构化数据(如会议行动项 [{owner,task,due}])。
//       这是模板型 recipe 的 AI 升级路径:模板做兜底,有模型时用模型产出真正有用的结果。
// 依赖:L1 provider(callProviderChatCompletion);纯提取逻辑,不落盘、不审批。
// 设计:模型只被要求输出严格 JSON(便于稳健解析);解析失败/无模型时由调用方回退模板。
import { callProviderChatCompletion } from '../kimi/provider/index.js';
import type { ModelConfig, ProviderChatArgs, ProviderChatResult } from '../kimi/provider/types.js';
import { combinedText, textOperation, xlsxOperation, binaryOperation, type SourceLike } from './recipe-helpers.js';
import { createDocxDocument, createPptxPresentation, createPdfDocument } from '../artifacts/office-writers.js';
import { createXlsxWorkbook } from '../artifacts/xlsx-writer.js';
import type { FileOperationInput } from '../workspace/file-operations.js';

export type ActionItem = { owner: string; task: string; due: string };

type ModelCaller = typeof callProviderChatCompletion;

// AI 提取的模型调用超时:模型没配好/不可达/卡住时,到点 abort → 抛错 → 回退模板,
// 绝不让一个挂住的模型调用拖死整个 recipe 运行(否则 HTTP 请求会一直挂到路由超时)。
const AI_MODEL_TIMEOUT_MS = 30_000;

async function callWithTimeout(modelCall: ModelCaller, args: ProviderChatArgs, ms = AI_MODEL_TIMEOUT_MS): Promise<ProviderChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await modelCall({ ...args, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型返回文本里稳健抽出第一个 JSON 数组/对象(容忍 ```json 包裹与前后废话)。 */
export function extractJson(text: unknown): unknown {
  const raw = String(text ?? '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate: string = (fenced && fenced[1]) || raw;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  // 从第一个 [ 或 { 起,按括号配平截取,避免尾部噪声破坏 JSON.parse。
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0; let end = -1; let inStr = false; let esc = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(candidate.slice(start, end)); } catch { return null; }
}

function cleanStr(value: unknown, fallback = ''): string {
  const s = String(value ?? '').trim();
  return s || fallback;
}

/** 把模型返回归一为行动项数组(容忍字段别名与非数组)。 */
export function normalizeActionItems(parsed: unknown): ActionItem[] {
  const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : []);
  return arr
    .map((row) => {
      const r = row && typeof row === 'object' ? row as Record<string, unknown> : {};
      return {
        owner: cleanStr(r.owner ?? r.负责人 ?? r.assignee ?? r.who, '未指定'),
        task: cleanStr(r.task ?? r.待办 ?? r.action ?? r.item ?? r.事项),
        due: cleanStr(r.due ?? r.截止 ?? r.deadline ?? r.date, '未定'),
      };
    })
    .filter((item) => item.task);
}

const MEETING_SYSTEM = '你是严谨的会议纪要助手。只输出 JSON,不要任何解释或 markdown 代码块。';
const MEETING_USER = (source: string, prompt: string) =>
  `从下面的会议记录中提取所有行动项,输出 JSON 数组,每项形如 {"owner":"负责人","task":"具体待办","due":"截止时间(没有就写\\"未定\\")"}。` +
  `只提取真实存在的待办,不要编造。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n会议记录:\n${source.slice(0, 8000)}`;

/**
 * 用模型从源材料提取会议行动项。无来源/模型失败/解析失败时返回 null(调用方回退模板)。
 */
export async function extractMeetingActions(
  { source, prompt = '', modelConfig, modelCall = callProviderChatCompletion }:
  { source: string; prompt?: string; modelConfig: ModelConfig; modelCall?: ModelCaller },
): Promise<ActionItem[] | null> {
  if (!String(source || '').trim()) return null;
  try {
    const result = await callWithTimeout(modelCall, {
      kimiConfig: modelConfig,
      messages: [
        { role: 'system', content: MEETING_SYSTEM },
        { role: 'user', content: MEETING_USER(String(source), String(prompt || '')) },
      ],
      tools: [],
    });
    const items = normalizeActionItems(extractJson((result as { content?: unknown })?.content));
    return items.length ? items : null;
  } catch {
    return null;
  }
}

export type AiRecipeArgs = {
  trustedRoot: string;
  recipe: { id: string; name: string };
  sources: SourceLike[];
  prompt?: string;
  modelConfig: ModelConfig;
  modelCall?: ModelCaller;
};

/** 会议纪要 AI 路径:模型提取行动项 → 格式化成 TXT/XLSX/DOCX。提取不到返回 null(回退模板)。 */
async function buildMeetingAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  const items = await extractMeetingActions({
    source,
    prompt: args.prompt ?? '',
    modelConfig: args.modelConfig,
    ...(args.modelCall ? { modelCall: args.modelCall } : {}),
  });
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

/** 通用:让模型只输出 JSON 并稳健解析(失败返回 null)。 */
async function callModelForJson(
  { system, user, modelConfig, modelCall = callProviderChatCompletion }:
  { system: string; user: string; modelConfig: ModelConfig; modelCall?: ModelCaller },
): Promise<unknown> {
  const result = await callWithTimeout(modelCall, {
    kimiConfig: modelConfig,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    tools: [],
  });
  return extractJson((result as { content?: unknown })?.content);
}

function strList(value: unknown, limit = 12): string[] {
  const arr = Array.isArray(value) ? value : [];
  return arr.map((v) => cleanStr(v)).filter(Boolean).slice(0, limit);
}

export type StructuredSummary = { title: string; keyPoints: string[]; risks: string[]; nextSteps: string[] };

/** 归一模型返回的结构化摘要;无任何有效内容时返回 null(回退模板)。 */
export function normalizeSummary(parsed: unknown): StructuredSummary | null {
  const r = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  if (!r) return null;
  const summary: StructuredSummary = {
    title: cleanStr(r.title ?? r.标题, '总结报告'),
    keyPoints: strList(r.keyPoints ?? r.要点 ?? r.points ?? r.highlights),
    risks: strList(r.risks ?? r.风险 ?? r.risk),
    nextSteps: strList(r.nextSteps ?? r.下一步 ?? r.actions ?? r.todos),
  };
  if (!summary.keyPoints.length && !summary.risks.length && !summary.nextSteps.length) return null;
  return summary;
}

function summaryLines(s: StructuredSummary, prompt: string): string[] {
  const section = (label: string, items: string[]) => (items.length ? [`【${label}】`, ...items.map((x) => `· ${x}`), ''] : []);
  return [
    s.title,
    prompt ? `用户指令: ${prompt}` : '',
    '',
    ...section('要点', s.keyPoints),
    ...section('风险', s.risks),
    ...section('下一步', s.nextSteps),
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));
}

/** 可复用:把材料交给模型做结构化摘要提取(要点/风险/下一步)。无内容返回 null。 */
async function extractSummary(args: AiRecipeArgs): Promise<StructuredSummary | null> {
  const source = combinedText(args.sources);
  if (!source.trim()) return null;
  const prompt = args.prompt ?? '';
  const parsed = await callModelForJson({
    system: '你是严谨的商务摘要助手。只输出 JSON,不要解释或 markdown。',
    user: `把下面材料整理成结构化摘要,输出 JSON {"title":"标题","keyPoints":["要点"],"risks":["风险点"],"nextSteps":["下一步行动"]}。只基于材料,不编造。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n材料:\n${source.slice(0, 8000)}`,
    modelConfig: args.modelConfig,
    ...(args.modelCall ? { modelCall: args.modelCall } : {}),
  });
  return normalizeSummary(parsed);
}

/** 总结报告 AI 路径:模型结构化摘要 → TXT/DOCX/PPTX/PDF(对齐模板产物类型)。 */
async function buildSummaryAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const s = await extractSummary(args);
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

/** 给老板看的一页总结 AI 路径:复用摘要提取,一页纸格式 → TXT/DOCX/PDF(对齐模板类型)。 */
async function buildBossSummaryAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const s = await extractSummary(args);
  if (!s) return null;
  const lines = summaryLines(s, args.prompt ?? '');
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: s.title, paragraphs: lines })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork One-Pager', lines })),
  ];
}

export type FeedbackCluster = { theme: string; severity: string; count: number; suggestion: string };

/** 归一模型返回的反馈聚类;无有效聚类返回 null(回退模板)。 */
export function normalizeClusters(parsed: unknown): FeedbackCluster[] | null {
  const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { clusters?: unknown }).clusters) ? (parsed as { clusters: unknown[] }).clusters : []);
  const clusters = arr
    .map((row) => {
      const r = row && typeof row === 'object' ? row as Record<string, unknown> : {};
      const countRaw = Number(r.count ?? r.数量 ?? r.数目);
      return {
        theme: cleanStr(r.theme ?? r.主题 ?? r.topic),
        severity: cleanStr(r.severity ?? r.严重度 ?? r.priority, '中'),
        count: Number.isFinite(countRaw) && countRaw > 0 ? Math.round(countRaw) : 1,
        suggestion: cleanStr(r.suggestion ?? r.建议 ?? r.action ?? r.建议动作, '待定'),
      };
    })
    .filter((c) => c.theme);
  return clusters.length ? clusters : null;
}

/** 反馈聚类 AI 路径:模型按主题/严重度聚合反馈并给建议动作 → TXT/DOCX(对齐模板类型)。 */
async function buildFeedbackClustersAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  if (!source.trim()) return null;
  const prompt = args.prompt ?? '';
  const parsed = await callModelForJson({
    system: '你是严谨的用户反馈分析助手。只输出 JSON,不要解释。',
    user: `把下面的用户反馈按主题聚类,输出 JSON 数组,每项 {"theme":"主题","severity":"严重度(高/中/低)","count":数量,"suggestion":"建议动作"}。只基于反馈,不编造。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n反馈:\n${source.slice(0, 8000)}`,
    modelConfig: args.modelConfig,
    ...(args.modelCall ? { modelCall: args.modelCall } : {}),
  });
  const clusters = normalizeClusters(parsed);
  if (!clusters) return null;
  const lines = [
    '用户反馈聚类(AI 提取)',
    prompt ? `用户指令: ${prompt}` : '',
    '',
    ...clusters.map((c, i) => `${i + 1}. 【${c.theme}】严重度 ${c.severity} · ${c.count} 条 → ${c.suggestion}`),
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: '用户反馈聚类', paragraphs: lines })),
  ];
}

export type ContractSummary = { parties: string; amount: string; term: string; obligations: string[]; risks: string[]; todos: string[] };

/** 归一模型返回的合同摘要;关键字段全空时返回 null(回退模板)。 */
export function normalizeContract(parsed: unknown): ContractSummary | null {
  const r = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  if (!r) return null;
  const c: ContractSummary = {
    parties: cleanStr(r.parties ?? r.主体 ?? r.甲乙方, '未识别'),
    amount: cleanStr(r.amount ?? r.付款 ?? r.金额, '未识别'),
    term: cleanStr(r.term ?? r.续约 ?? r.期限, '未识别'),
    obligations: strList(r.obligations ?? r.义务 ?? r.责任),
    risks: strList(r.risks ?? r.风险 ?? r.风险点),
    todos: strList(r.todos ?? r.待确认 ?? r.待办),
  };
  if (!c.obligations.length && !c.risks.length && !c.todos.length && c.parties === '未识别' && c.amount === '未识别') return null;
  return c;
}

/** 合同摘要 AI 路径:模型提取关键条款 → TXT/DOCX/PDF(对齐模板产物类型)。 */
async function buildContractAiOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  const source = combinedText(args.sources);
  if (!source.trim()) return null;
  const prompt = args.prompt ?? '';
  const parsed = await callModelForJson({
    system: '你是严谨的法务合同摘要助手。只输出 JSON,不要解释。不确定的字段写"未识别",不要编造。',
    user: `提取下面合同的关键信息,输出 JSON {"parties":"签约主体","amount":"付款/金额","term":"期限/续约","obligations":["主要义务"],"risks":["风险点"],"todos":["待确认事项"]}。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n合同:\n${source.slice(0, 8000)}`,
    modelConfig: args.modelConfig,
    ...(args.modelCall ? { modelCall: args.modelCall } : {}),
  });
  const c = normalizeContract(parsed);
  if (!c) return null;
  const section = (label: string, items: string[]) => (items.length ? [`【${label}】`, ...items.map((x) => `· ${x}`), ''] : []);
  const lines = [
    '合同摘要(AI 提取)',
    `签约主体: ${c.parties}`,
    `付款/金额: ${c.amount}`,
    `期限/续约: ${c.term}`,
    '',
    ...section('主要义务', c.obligations),
    ...section('风险点', c.risks),
    ...section('待确认事项', c.todos),
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));
  const { trustedRoot, recipe } = args;
  return [
    textOperation(trustedRoot, recipe.id, `${recipe.name}.txt`, lines.join('\n')),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.docx`, createDocxDocument({ title: '合同摘要', paragraphs: lines })),
    binaryOperation(trustedRoot, recipe.id, `${recipe.name}.pdf`, createPdfDocument({ title: 'Agent Cowork Contract Summary', lines })),
  ];
}

// recipe id → AI 构造器。有模型且命中时用 AI,否则调用方回退模板。
const AI_RECIPE_BUILDERS: Record<string, (args: AiRecipeArgs) => Promise<FileOperationInput[] | null>> = {
  'meeting-actions': buildMeetingAiOperations,
  'summary-report': buildSummaryAiOperations,
  'contract-summary': buildContractAiOperations,
  'boss-summary-onepager': buildBossSummaryAiOperations,
  'feedback-clusters': buildFeedbackClustersAiOperations,
};

export function hasAiRecipeBuilder(recipeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_RECIPE_BUILDERS, recipeId);
}

/** 有模型配置且该 recipe 有 AI 路径时,产出 AI operations;否则返回 null(回退模板)。 */
export async function buildAiRecipeOperations(args: AiRecipeArgs): Promise<FileOperationInput[] | null> {
  if (!args.modelConfig) return null;
  const builder = AI_RECIPE_BUILDERS[args.recipe.id];
  if (!builder) return null;
  try { return await builder(args); } catch { return null; }
}
