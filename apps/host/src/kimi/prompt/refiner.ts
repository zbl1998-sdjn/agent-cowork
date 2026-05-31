// 提示词精炼器(host · L1 领域层 · kimi/prompt)
// ---------------------------------------------------------------------------
// 职责:依精炼策略决定是否精炼;可调模型(带超时)改写 prompt,失败或无模型
//       时退回基于上下文(项目/术语)的本地兜底改写;追问场景则原样返回。
// 依赖:同层 refine-policy(策略判定);其余仅标准库。
// 导出:refinePrompt(异步函数)、createPromptRefiner(工厂)。

import { analyzePromptForRefine, type PromptAnalyzeOptions, type PromptIntent, type PromptMissing, type PromptPolicy } from './refine-policy.js';

type ProfileLike = { terms?: unknown[]; project?: unknown; entries?: unknown[] };
export type PromptContext = { profile?: ProfileLike | null; userProfile?: ProfileLike | null; project?: unknown; [key: string]: unknown };
type PromptModelInput = { prompt: string; context: PromptContext; intent: PromptIntent; missing: PromptMissing[] };
export type PromptModelCall = (input: PromptModelInput) => unknown | Promise<unknown>;
type PromptRefinerOptions = PromptAnalyzeOptions & { modelCall?: PromptModelCall; timeoutMs?: number };
export type PromptRefineResult = { refined: string; changed: boolean; intent: PromptIntent; missing: PromptMissing[] };
export type PromptRefiner = { refine(raw: unknown, ctx?: PromptContext): Promise<PromptRefineResult> };

const INTENT_LABELS = {
  create: '创建/实现',
  fix: '修复',
  review: '审查/分析',
  summarize: '总结/整理',
  translate: '翻译',
  general: '通用任务',
  unknown: '未知',
};

function contextTerms(ctx: PromptContext = {}): string[] {
  const profile = ctx.profile || ctx.userProfile || {};
  const terms = Array.isArray(profile.terms) ? profile.terms : [];
  const project = typeof ctx.project === 'string' && ctx.project.trim()
    ? ctx.project.trim()
    : typeof profile.project === 'string'
      ? profile.project.trim()
      : '';
  return [project, ...terms.map((term) => String(term).trim())].filter(Boolean).slice(0, 6);
}

function fallbackRefinement(original: string, policy: PromptPolicy, ctx: PromptContext): string {
  const lines = [
    `请基于以下原始需求执行任务：${original}`,
    `任务类型：${INTENT_LABELS[policy.intent] || INTENT_LABELS.general}`,
  ];
  const terms = contextTerms(ctx);
  if (terms.length) {
    lines.push(`相关上下文：${terms.join('、')}`);
  }
  lines.push('请先确认关键假设；如需修改文件，先说明计划，再给出结果、依据和下一步。');
  return lines.join('\n');
}

function resultFromPolicy(policy: PromptPolicy): PromptRefineResult {
  return {
    refined: policy.normalized,
    changed: false,
    intent: policy.intent,
    missing: policy.missing,
  };
}

function modelText(output: unknown): string {
  if (typeof output === 'string') return output;
  const record = output && typeof output === 'object'
    ? output as { text?: unknown; content?: unknown }
    : null;
  if (typeof record?.text === 'string') return record.text;
  if (typeof record?.content === 'string') return record.content;
  return '';
}

async function withTimeout<T>(value: T | Promise<T>, timeoutMs?: number): Promise<T> {
  const promise = Promise.resolve(value);
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Prompt refinement timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 精炼一条 prompt:能精炼则调模型/兜底改写,需追问或已明确则原样返回。 */
export async function refinePrompt(raw: unknown, ctx: PromptContext = {}, options: PromptRefinerOptions = {}): Promise<PromptRefineResult> {
  const policy = analyzePromptForRefine(raw, options);
  if (policy.needsClarification || !policy.shouldRefine) {
    return resultFromPolicy(policy);
  }

  const modelCall = options.modelCall;
  if (typeof modelCall === 'function') {
    try {
      const output = await withTimeout(modelCall({
        prompt: policy.normalized,
        context: ctx,
        intent: policy.intent,
        missing: policy.missing,
      }), options.timeoutMs ?? 3500);
      const refined = modelText(output).trim();
      if (refined && refined !== policy.normalized) {
        return { refined, changed: true, intent: policy.intent, missing: [] };
      }
    } catch {
      return resultFromPolicy(policy);
    }
  }

  const refined = fallbackRefinement(policy.normalized, policy, ctx);
  return {
    refined,
    changed: refined !== policy.normalized,
    intent: policy.intent,
    missing: [],
  };
}

/** 创建绑定好选项的精炼器对象(暴露 refine 方法)。 */
export function createPromptRefiner(options: PromptRefinerOptions = {}): PromptRefiner {
  return {
    refine(raw: unknown, ctx: PromptContext = {}) {
      return refinePrompt(raw, ctx, options);
    },
  };
}
