import { analyzePromptForRefine } from './refine-policy.js';

/**
 * @typedef {import('./refine-policy.js').PromptIntent} PromptIntent
 * @typedef {import('./refine-policy.js').PromptPolicy} PromptPolicy
 * @typedef {{ terms?: unknown[], project?: unknown, entries?: unknown[] }} ProfileLike
 * @typedef {{ profile?: ProfileLike | null, userProfile?: ProfileLike | null, project?: unknown, [key: string]: unknown }} PromptContext
 * @typedef {{ prompt: string, context: PromptContext, intent: PromptIntent, missing: string[] }} PromptModelInput
 * @typedef {(input: PromptModelInput) => unknown | Promise<unknown>} PromptModelCall
 * @typedef {{ modelCall?: PromptModelCall, timeoutMs?: number, maxLength?: number }} PromptRefinerOptions
 * @typedef {{ refined: string, changed: boolean, intent: PromptIntent, missing: string[] }} PromptRefineResult
 * @typedef {{ refine(raw: unknown, ctx?: PromptContext): Promise<PromptRefineResult> }} PromptRefiner
 */

/** @type {Record<PromptIntent, string>} */
const INTENT_LABELS = {
  create: '创建/实现',
  fix: '修复',
  review: '审查/分析',
  summarize: '总结/整理',
  translate: '翻译',
  general: '通用任务',
  unknown: '未知',
};

/** @param {PromptContext} [ctx] @returns {string[]} */
function contextTerms(ctx = {}) {
  const profile = ctx.profile || ctx.userProfile || {};
  const terms = Array.isArray(profile.terms) ? profile.terms : [];
  const project = typeof ctx.project === 'string' && ctx.project.trim()
    ? ctx.project.trim()
    : typeof profile.project === 'string'
      ? profile.project.trim()
      : '';
  return [project, ...terms.map((term) => String(term).trim())].filter(Boolean).slice(0, 6);
}

/** @param {string} original @param {PromptPolicy} policy @param {PromptContext} ctx @returns {string} */
function fallbackRefinement(original, policy, ctx) {
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

/** @param {PromptPolicy} policy @returns {PromptRefineResult} */
function resultFromPolicy(policy) {
  return {
    refined: policy.normalized,
    changed: false,
    intent: policy.intent,
    missing: policy.missing,
  };
}

/** @param {unknown} output @returns {string} */
function modelText(output) {
  if (typeof output === 'string') return output;
  const record = /** @type {{ text?: unknown, content?: unknown } | null} */ (
    output && typeof output === 'object' ? output : null
  );
  if (typeof record?.text === 'string') return record.text;
  if (typeof record?.content === 'string') return record.content;
  return '';
}

/** @template T @param {T | Promise<T>} value @param {number | undefined} timeoutMs @returns {Promise<T>} */
async function withTimeout(value, timeoutMs) {
  const promise = Promise.resolve(value);
  if (!timeoutMs || timeoutMs <= 0) return promise;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Prompt refinement timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @param {unknown} raw @param {PromptContext} [ctx] @param {PromptRefinerOptions} [options] @returns {Promise<PromptRefineResult>} */
export async function refinePrompt(raw, ctx = {}, options = {}) {
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

/** @param {PromptRefinerOptions} [options] @returns {PromptRefiner} */
export function createPromptRefiner(options = {}) {
  return {
    /** @param {unknown} raw @param {PromptContext} [ctx] */
    refine(raw, ctx = {}) {
      return refinePrompt(raw, ctx, options);
    },
  };
}
