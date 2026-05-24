import { analyzePromptForRefine } from '../prompt/refine-policy.js';

const MISSING_TEXT = {
  action: '要执行的动作',
  target: '要处理的对象或文件',
  desiredOutput: '期望输出形式',
  goal: '任务目标',
};

function describeMissing(missing) {
  return missing.map((item) => MISSING_TEXT[item] || item).join('、');
}

export function buildPromptClarification(policy) {
  const missing = describeMissing(policy.missing);
  return {
    question: missing
      ? `这个任务还缺少${missing}。你希望我具体怎么做？`
      : '你希望我具体怎么做？',
    options: [
      { label: '补充具体目标', description: '说明要处理的对象、动作和期望结果' },
      { label: '先做只读梳理', description: '我先查看相关资料并列出需要确认的问题' },
    ],
  };
}

export async function clarifyPromptBeforeModel({ prompt, userContent, toolMap }) {
  if (Array.isArray(userContent) && userContent.length) {
    return { prompt, clarified: false };
  }
  const policy = analyzePromptForRefine(prompt);
  if (!policy.needsClarification) {
    return { prompt: policy.normalized || String(prompt || ''), clarified: false };
  }
  const askTool = toolMap.get('AskUserQuestion');
  if (!askTool || typeof askTool.handler !== 'function') {
    return { prompt: policy.normalized || String(prompt || ''), clarified: false };
  }

  const { question, options } = buildPromptClarification(policy);
  const result = await askTool.handler({ question, options });
  const answer = String(result?.answer || '').trim();
  if (!answer || answer === 'reject') {
    return { prompt: policy.normalized || String(prompt || ''), clarified: false };
  }
  const base = policy.normalized || String(prompt || '').trim();
  return {
    prompt: `${base}\n\n[用户澄清]\n${answer}`,
    clarified: true,
    missing: policy.missing,
  };
}
