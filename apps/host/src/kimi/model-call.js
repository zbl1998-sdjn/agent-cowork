import { callProviderChatCompletion } from './provider/index.js';

export async function defaultAgentModelCall({ messages, tools, kimiConfig, fetchImpl = globalThis.fetch, onContent, onReasoning, signal }) {
  return callProviderChatCompletion({ messages, tools, kimiConfig, fetchImpl, onContent, onReasoning, signal });
}
