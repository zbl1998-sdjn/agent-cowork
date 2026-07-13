// 模型驱动 recipe 的提取层(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:把源材料交给已配置模型做「结构化提取」,只依赖 provider + L0 出站网关,不碰
//       office-writers/落盘。模型只被要求输出严格 JSON;解析失败/无来源/模型失败/出站
//       策略拒绝一律返回 null,由调用方回退模板。
// 依赖:L1 provider(callProviderChatCompletion);L0 security/egress-gateway(出站闸门——
//       与 kimi/agent/model-resilience.ts 的对话路径共用同一策略,机密档 air_gap/
//       local_strict 下必须同样拒绝出网,不能因为走了 recipe 分支就绕过)。
import { callProviderChatCompletion } from '../engine/provider/index.js';
import type { ModelConfig, ProviderChatArgs, ProviderChatResult } from '../engine/provider/types.js';
import {
  decideEgressPolicy,
  enforceRecordedEgressDecision,
  isEgressAuditFailure,
} from '../security/egress-gateway.js';

export type ModelCaller = typeof callProviderChatCompletion;
export type ActionItem = { owner: string; task: string; due: string };
export type StructuredSummary = { title: string; keyPoints: string[]; risks: string[]; nextSteps: string[] };
export type FeedbackCluster = { theme: string; severity: string; count: number; suggestion: string };
export type ContractSummary = { parties: string; amount: string; term: string; obligations: string[]; risks: string[]; todos: string[] };
export type WeeklyReport = { title: string; done: string[]; doing: string[]; next: string[]; risks: string[] };
export type CleanedTable = { columns: string[]; rows: string[][]; issues: string[] };

// AI 提取的模型调用超时:模型没配好/不可达/卡住时,到点 abort → 抛错 → 回退模板,
// 绝不让一个挂住的模型调用拖死整个 recipe 运行(否则 HTTP 请求会一直挂到路由超时)。
const AI_MODEL_TIMEOUT_MS = 30_000;

/** 唯一的模型调用出口:先过出站策略(与对话路径共用同一闸门),拒绝就抛错(调用方回退模板);
 * 通过则带超时调用。trustedRoot 存在时把出站决策记进审计,与对话路径保持同等可审计性。 */
async function callWithTimeout(modelCall: ModelCaller, args: ProviderChatArgs, trustedRoot?: unknown, ms = AI_MODEL_TIMEOUT_MS): Promise<ProviderChatResult> {
  const modelConfig = args.modelConfig as ModelConfig;
  const egress = decideEgressPolicy({
    kind: 'model_inference',
    provider: modelConfig?.provider,
    model: modelConfig?.model,
    baseUrl: modelConfig?.baseUrl,
    securityMode: modelConfig?.securityMode,
    content: args.messages,
    trustedRoot,
  });
  enforceRecordedEgressDecision(trustedRoot, egress);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await modelCall({ ...args, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 剔除思考模型(qwen3 / deepseek-r1 等)的推理块 <think>…</think>。这些块里常含方括号或
 * 示例 JSON,会破坏或误导后面的 JSON 抽取(实测导致会议纪要等 AI recipe 回退模板)。 */
export function stripReasoning(raw: string): string {
  let out = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ').replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, ' ');
  // 只有闭合标签(开标签在更早被截断/流式丢头):取最后一个 </think> 之后的正文。
  const lastClose = out.toLowerCase().lastIndexOf('</think>');
  if (lastClose >= 0) out = out.slice(lastClose + '</think>'.length);
  return out;
}

/** 从模型返回文本里稳健抽出第一个 JSON 数组/对象(先剔除思考块,再容忍 ```json 包裹与前后废话)。 */
export function extractJson(text: unknown): unknown {
  const raw = stripReasoning(String(text ?? ''));
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

export function cleanStr(value: unknown, fallback = ''): string {
  const s = String(value ?? '').trim();
  return s || fallback;
}

export function strList(value: unknown, limit = 12): string[] {
  const arr = Array.isArray(value) ? value : [];
  return arr.map((v) => cleanStr(v)).filter(Boolean).slice(0, limit);
}

/** 通用:让模型只输出 JSON 并稳健解析(失败返回 null)。 */
export async function callModelForJson(
  { system, user, modelConfig, modelCall = callProviderChatCompletion, trustedRoot }:
  { system: string; user: string; modelConfig: ModelConfig; modelCall?: ModelCaller; trustedRoot?: unknown },
): Promise<unknown> {
  const result = await callWithTimeout(modelCall, {
    modelConfig: modelConfig,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    tools: [],
  }, trustedRoot);
  return extractJson((result as { content?: unknown })?.content);
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

/** 归一模型返回的周报结构;四段全空返回 null(回退模板)。 */
export function normalizeWeekly(parsed: unknown): WeeklyReport | null {
  const r = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  if (!r) return null;
  const w: WeeklyReport = {
    title: cleanStr(r.title ?? r.标题, '本周工作周报'),
    done: strList(r.done ?? r.本周完成 ?? r.completed ?? r.已完成),
    doing: strList(r.doing ?? r.进行中 ?? r.inProgress ?? r.ongoing),
    next: strList(r.next ?? r.下周计划 ?? r.nextWeek ?? r.plan),
    risks: strList(r.risks ?? r.风险 ?? r.blockers ?? r.阻塞),
  };
  if (!w.done.length && !w.doing.length && !w.next.length && !w.risks.length) return null;
  return w;
}

/** 归一模型返回的清洗后表格:列名规整,每行按列数补齐/截断,过滤全空行。无有效行返回 null。 */
export function normalizeTable(parsed: unknown): CleanedTable | null {
  const r = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  if (!r) return null;
  const columns = strList(r.columns ?? r.列 ?? r.表头, 50).map((c) => cleanStr(c));
  if (!columns.length) return null;
  const rawRows = Array.isArray(r.rows ?? r.数据 ?? r.行) ? (r.rows ?? r.数据 ?? r.行) as unknown[] : [];
  const width = columns.length;
  const rows = rawRows
    .map((row) => {
      const cells = Array.isArray(row) ? row.map((c) => cleanStr(c)) : [cleanStr(row)];
      const padded = cells.slice(0, width);
      while (padded.length < width) padded.push('');
      return padded;
    })
    .filter((row) => row.some((cell) => cell !== ''));
  if (!rows.length) return null;
  return { columns, rows, issues: strList(r.issues ?? r.问题 ?? r.notes) };
}

const MEETING_SYSTEM = '你是严谨的会议纪要助手。只输出 JSON,不要任何解释或 markdown 代码块。';
const MEETING_USER = (source: string, prompt: string) =>
  `从下面的会议记录中提取所有行动项,输出 JSON 数组,每项形如 {"owner":"负责人","task":"具体待办","due":"截止时间(没有就写\\"未定\\")"}。` +
  `只提取真实存在的待办,不要编造。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n会议记录:\n${source.slice(0, 8000)}`;

/** 用模型从源材料提取会议行动项。无来源/模型失败/解析失败时返回 null(调用方回退模板)。 */
export async function extractMeetingActions(
  { source, prompt = '', modelConfig, modelCall = callProviderChatCompletion, trustedRoot }:
  { source: string; prompt?: string; modelConfig: ModelConfig; modelCall?: ModelCaller; trustedRoot?: unknown },
): Promise<ActionItem[] | null> {
  if (!String(source || '').trim()) return null;
  try {
    const result = await callWithTimeout(modelCall, {
      modelConfig: modelConfig,
      messages: [
        { role: 'system', content: MEETING_SYSTEM },
        { role: 'user', content: MEETING_USER(String(source), String(prompt || '')) },
      ],
      tools: [],
    }, trustedRoot);
    const items = normalizeActionItems(extractJson((result as { content?: unknown })?.content));
    return items.length ? items : null;
  } catch (error) {
    if (isEgressAuditFailure(error)) throw error;
    return null;
  }
}

/** 把材料交给模型做结构化摘要提取(要点/风险/下一步)。无内容返回 null。 */
export async function extractSummary(
  { source, prompt = '', modelConfig, modelCall, trustedRoot }:
  { source: string; prompt?: string; modelConfig: ModelConfig; modelCall?: ModelCaller; trustedRoot?: unknown },
): Promise<StructuredSummary | null> {
  if (!String(source || '').trim()) return null;
  const parsed = await callModelForJson({
    system: '你是严谨的商务摘要助手。只输出 JSON,不要解释或 markdown。',
    user: `把下面材料整理成结构化摘要,输出 JSON {"title":"标题","keyPoints":["要点"],"risks":["风险点"],"nextSteps":["下一步行动"]}。只基于材料,不编造。${prompt ? `用户额外要求:${prompt}。` : ''}\n\n材料:\n${source.slice(0, 8000)}`,
    modelConfig,
    ...(modelCall ? { modelCall } : {}),
    trustedRoot,
  });
  return normalizeSummary(parsed);
}
