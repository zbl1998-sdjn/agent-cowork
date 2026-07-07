// 模型驱动的 recipe 提取(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:把 recipe 的源材料交给已配置的模型(Ollama/Kimi 等)做「结构化提取」,
//       返回可被 office-writers 格式化的结构化数据(如会议行动项 [{owner,task,due}])。
//       这是模板型 recipe 的 AI 升级路径:模板做兜底,有模型时用模型产出真正有用的结果。
// 依赖:L1 provider(callProviderChatCompletion);纯提取逻辑,不落盘、不审批。
// 设计:模型只被要求输出严格 JSON(便于稳健解析);解析失败/无模型时由调用方回退模板。
import { callProviderChatCompletion } from '../kimi/provider/index.js';
import type { ModelConfig } from '../kimi/provider/types.js';
import { combinedText, textOperation, xlsxOperation, binaryOperation, type SourceLike } from './recipe-helpers.js';
import { createDocxDocument } from '../artifacts/office-writers.js';
import { createXlsxWorkbook } from '../artifacts/xlsx-writer.js';
import type { FileOperationInput } from '../workspace/file-operations.js';

export type ActionItem = { owner: string; task: string; due: string };

type ModelCaller = typeof callProviderChatCompletion;

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
    const result = await modelCall({
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

// recipe id → AI 构造器。有模型且命中时用 AI,否则调用方回退模板。
const AI_RECIPE_BUILDERS: Record<string, (args: AiRecipeArgs) => Promise<FileOperationInput[] | null>> = {
  'meeting-actions': buildMeetingAiOperations,
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
