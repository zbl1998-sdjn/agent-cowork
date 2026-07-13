// 提示词改写模型调用(host · L1 领域层 · kimi/prompt)
// ---------------------------------------------------------------------------
// 职责:把 refiner 的 {prompt,intent,missing,context} 组装成「改写指令 + 原始提示」两条消息,
//       发一次非流式 chat/completions,返回改写后的纯文本(只改写、不回答任务)。
// 说明:刻意走独立的最小 fetch,而非 provider 流式入口——provider 固定带 tool_choice:'auto',
//       无 tools 时易被拒;改写只需一次性补全,自带超时/中断更可控。失败/超时统一返回空串,
//       由 refiner 判定为「无需改写」,绝不打断输入流程。
// 依赖:../api-runner-config(默认 baseUrl/model)。导出:createKimiRefineModelCall。
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../api-runner-config.js';
import { createModelEndpointFetch } from '../../security/model-endpoint-request.js';
import { decideEgressPolicy, enforceRecordedEgressDecision } from '../../security/egress-gateway.js';
import type { PromptContext, PromptModelCall } from './refiner.js';

type FetchLike = typeof globalThis.fetch;
type RefineModelCallDeps = {
  modelConfig: Record<string, unknown>;
  fetchImpl?: FetchLike;
};

const INTENT_LABELS: Record<string, string> = {
  create: '创建/实现',
  fix: '修复',
  review: '审查/分析',
  summarize: '总结/整理',
  translate: '翻译',
  general: '通用任务',
  unknown: '通用任务',
};

const SYSTEM_PROMPT = [
  '你是“提示词改写器”。把用户给的【原始提示】改写得更清晰、可执行,方便另一个 AI 准确完成任务。',
  '规则:',
  '- 只输出改写后的提示词本身,不要解释、不要前后缀,更不要直接回答或执行该任务。',
  '- 保留用户的原意与语言,不要新增用户没提到的事实或约束。',
  '- 可以补上明确的动作、对象或期望产出的结构,但不要编造具体内容。',
  '- 简洁,通常 1–4 句。',
].join('\n');

function contextTerms(ctx: PromptContext = {}): string[] {
  const profile = (ctx.profile || ctx.userProfile || {}) as { terms?: unknown[] };
  const terms = Array.isArray(profile.terms) ? profile.terms : [];
  const project = typeof ctx.project === 'string' ? ctx.project.trim() : '';
  return [project, ...terms.map((term) => String(term).trim())].filter(Boolean).slice(0, 6);
}

function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices && choices[0] && choices[0].message ? choices[0].message.content : '';
  return typeof content === 'string' ? content : '';
}

/** 用当前 Kimi 配置造一个 refiner 用的模型调用:发一次非流式补全,返回改写文本(失败/超时返回空串)。 */
export function createKimiRefineModelCall(
  { modelConfig, fetchImpl = globalThis.fetch }: RefineModelCallDeps,
): PromptModelCall {
  return async ({ prompt, context, intent, missing }) => {
    const apiKey = String(modelConfig.apiKey || '');
    if (!apiKey || typeof fetchImpl !== 'function') return '';
    const baseUrl = String(modelConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = String(modelConfig.model || DEFAULT_MODEL);
    const maxTokens = Math.max(1, Number(modelConfig.maxTokens) || 1024);
    const timeoutMs = Math.max(1000, Number(modelConfig.timeoutMs) || 15_000);
    const temperature = Number(modelConfig.temperature);
    const terms = contextTerms(context);
    const hints = [
      `任务类型:${INTENT_LABELS[intent] || INTENT_LABELS.general}`,
      missing && missing.length ? `可补强的要素:${missing.join('、')}` : '',
      terms.length ? `相关上下文:${terms.join('、')}` : '',
    ].filter(Boolean).join('\n');
    const endpoint = `${baseUrl}/chat/completions`;
    const messages = [
      { role: 'system', content: hints ? `${SYSTEM_PROMPT}\n${hints}` : SYSTEM_PROMPT },
      { role: 'user', content: String(prompt || '') },
    ];
    enforceRecordedEgressDecision(context.trustedRoot, decideEgressPolicy({
      kind: 'model_inference',
      destination: endpoint,
      provider: modelConfig.provider,
      model,
      baseUrl,
      securityMode: modelConfig.securityMode,
      content: messages,
    }));
    const modelFetch = createModelEndpointFetch(modelConfig, { fetchImpl: fetchImpl as never });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await modelFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          ...(Number.isFinite(temperature) ? { temperature } : {}),
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return '';
      return extractContent(await response.json()).trim();
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  };
}
