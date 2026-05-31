// 进模型前的提示澄清层(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:在调用模型前判断用户 prompt 是否信息不足(缺动作/对象/期望/目标);
//      若需澄清且存在 AskUserQuestion 工具,则向用户提一个带选项的问题,
//      把回答拼回 prompt 后再继续;否则返回规整后的 prompt。
// 依赖:同层 prompt/refine-policy.js(分析提示完整度);AskUserQuestion 工具(可选)。
// 导出:buildPromptClarification / clarifyPromptBeforeModel
import { analyzePromptForRefine } from '../prompt/refine-policy.js';

export type MissingKey = 'action' | 'target' | 'desiredOutput' | 'goal';
export type ClarificationPolicy = { missing?: unknown[]; needsClarification?: boolean; normalized?: string };
export type ClarificationOption = { label: string; description: string };
export type AskTool = {
  handler?: (args: { question: string; options: ClarificationOption[] }) => unknown | Promise<unknown>;
};
export type ClarifyOptions = { prompt?: unknown; userContent?: unknown; toolMap: Map<string, AskTool> };
export type ClarifyResult = { prompt: unknown; clarified: boolean; missing?: unknown[] };

const MISSING_TEXT: Record<MissingKey, string> = {
  action: '要执行的动作',
  target: '要处理的对象或文件',
  desiredOutput: '期望输出形式',
  goal: '任务目标',
};

function describeMissing(missing: unknown[] | undefined): string {
  return (missing || []).map((item) => MISSING_TEXT[item as MissingKey] || String(item)).join('、');
}

/** 据缺失项构造给用户的澄清问题与候选选项(补充目标 / 先做只读梳理)。 */
export function buildPromptClarification(policy: ClarificationPolicy): { question: string; options: ClarificationOption[] } {
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

/** 进模型前的澄清主流程:多模态输入或无需澄清则直接放行,否则提问并把答案并入 prompt。 */
export async function clarifyPromptBeforeModel({ prompt, userContent, toolMap }: ClarifyOptions): Promise<ClarifyResult> {
  if (Array.isArray(userContent) && userContent.length) {
    return { prompt, clarified: false };
  }
  const policy = analyzePromptForRefine(String(prompt || '')) as ClarificationPolicy;
  if (!policy.needsClarification) {
    return { prompt: policy.normalized || String(prompt || ''), clarified: false };
  }
  const askTool = toolMap.get('AskUserQuestion');
  if (!askTool || typeof askTool.handler !== 'function') {
    return { prompt: policy.normalized || String(prompt || ''), clarified: false };
  }

  const { question, options } = buildPromptClarification(policy);
  const result = await askTool.handler({ question, options }) as { answer?: unknown };
  const answer = String(result && result.answer || '').trim();
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
