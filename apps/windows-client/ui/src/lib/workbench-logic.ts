import type { AssistantMessage, Message } from './app-types';
import type { WorkbenchGenerationSnapshot } from './types/composer';

export function latestWorkbenchGeneration(messages: Message[]): WorkbenchGenerationSnapshot | undefined {
  const message = [...messages].reverse().find((item): item is AssistantMessage => item.role === 'assistant');
  if (!message) return undefined;
  return {
    text: message.text || '',
    status: message.status,
    progress: message.progress.map((item) => ({ text: item.text, status: item.status })),
    tools: (message.tools || []).map((tool) => ({ name: tool.name, status: tool.status })),
    updatedAt: new Date().toISOString(),
  };
}
