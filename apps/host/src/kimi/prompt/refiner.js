import { analyzePromptForRefine } from './refine-policy.js';

const INTENT_LABELS = {
  create: '创建/实现',
  fix: '修复',
  review: '审查/分析',
  summarize: '总结/整理',
  translate: '翻译',
  general: '通用任务',
  unknown: '未知',
};

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

function resultFromPolicy(policy) {
  return {
    refined: policy.normalized,
    changed: false,
    intent: policy.intent,
    missing: policy.missing,
  };
}

function modelText(output) {
  if (typeof output === 'string') return output;
  if (output && typeof output.text === 'string') return output.text;
  if (output && typeof output.content === 'string') return output.content;
  return '';
}

async function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Prompt refinement timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

export function createPromptRefiner(options = {}) {
  return {
    refine(raw, ctx = {}) {
      return refinePrompt(raw, ctx, options);
    },
  };
}
