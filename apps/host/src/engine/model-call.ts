// 默认模型调用适配器(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:为 agent 运行时提供默认的「调一次大模型 chat completion」实现,
//       薄封装到 provider 层,便于在测试中替换为桩函数。
// 依赖:./provider(统一的多 provider chat completion 入口)。
// 导出:defaultAgentModelCall。
import { callProviderChatCompletion } from './provider/index.js';
import { omitUndefined } from '../util/object.js';

type ProviderChatArgs = Parameters<typeof callProviderChatCompletion>[0];

/** 默认的 agent 模型调用:直接转发到 provider 层的 chat completion。 */
export async function defaultAgentModelCall({ messages, tools, modelConfig, fetchImpl = globalThis.fetch, onContent, onReasoning, signal, promptCacheKey }: ProviderChatArgs) {
  return callProviderChatCompletion(omitUndefined({ messages, tools, modelConfig, fetchImpl, onContent, onReasoning, signal, promptCacheKey }));
}
