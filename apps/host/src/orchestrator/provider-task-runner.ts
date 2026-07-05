import { callProviderChatCompletion } from '../kimi/provider/index.js';
import type { ModelConfig, ProviderChatArgs, ProviderChatResult } from '../kimi/provider/index.js';
import type {
  AgentDefinition,
  AgentResult,
  AgentTask,
  AgentUsage,
  ContextPack,
  JsonObject,
} from './types.js';

const ZERO_USAGE: AgentUsage = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  runtimeMs: 0,
  filesRead: 0,
  bytesRead: 0,
};

type ProviderModelCall = (args: ProviderChatArgs) => Promise<ProviderChatResult>;

export type ProviderTaskRunnerOptions = {
  modelConfig: ModelConfig;
  modelCall?: ProviderModelCall | undefined;
  fetchImpl?: unknown;
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function numberField(source: unknown, keys: string[]): number {
  if (!source || typeof source !== 'object') return 0;
  const row = source as Record<string, unknown>;
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function usageFrom(result: ProviderChatResult, fallbackInputChars: number, output: string, runtimeMs: number): AgentUsage {
  const usage = result.usage;
  const inputTokens = numberField(usage, ['prompt_tokens', 'input_tokens']) || estimateTokens(String(fallbackInputChars));
  const outputTokens = numberField(usage, ['completion_tokens', 'output_tokens']) || estimateTokens(output);
  return {
    ...ZERO_USAGE,
    modelCalls: 1,
    inputTokens,
    outputTokens,
    runtimeMs,
  };
}

function stringContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const item = part as { text?: unknown; content?: unknown };
    return typeof item.text === 'string' ? item.text : (typeof item.content === 'string' ? item.content : '');
  }).filter(Boolean).join('\n');
}

function messageText(result: ProviderChatResult): string {
  const direct = stringContent(result.content);
  if (direct) return direct;
  return '';
}

function contextText(pack: ContextPack): string {
  return pack.entries.map((entry) => [
    `source: ${entry.label}`,
    entry.uri ? `uri: ${entry.uri}` : '',
    entry.text,
  ].filter(Boolean).join('\n')).join('\n\n').slice(0, 16_000);
}

function buildMessages(task: AgentTask, pack: ContextPack, agent: AgentDefinition): ProviderChatArgs['messages'] {
  return [
    {
      role: 'system',
      content: [
        agent.rolePrompt,
        'Return a concise, evidence-grounded result for this orchestration task.',
        'Do not claim access to files or tools that are not present in the supplied context.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Goal: ${pack.userGoalSummary}`,
        `Task: ${task.title}`,
        `Instruction: ${task.instruction}`,
        `Expected output: ${task.expectedOutput}`,
        `Output schema: ${task.outputSchemaName}`,
        '',
        'Context:',
        contextText(pack) || 'No context entries were supplied.',
      ].join('\n'),
    },
  ];
}

function structuredResult(result: ProviderChatResult, summary: string, pack: ContextPack): JsonObject {
  return {
    summary,
    runner: 'provider-adapter',
    provider: typeof result.provider === 'string' ? result.provider : '',
    model: typeof result.model === 'string' ? result.model : '',
    sourceCount: pack.entries.length,
    redactedCount: pack.redactionReport.redactedCount,
    finishReason: typeof result.finish_reason === 'string' ? result.finish_reason : '',
    streamInterrupted: result.stream_interrupted === true,
  };
}

export function createProviderTaskRunner({
  modelConfig,
  modelCall = callProviderChatCompletion,
  fetchImpl,
}: ProviderTaskRunnerOptions) {
  return async function providerTaskRunner(
    task: AgentTask,
    pack: ContextPack,
    agent: AgentDefinition,
    controls: { signal?: AbortSignal | null | undefined } = {},
  ): Promise<AgentResult> {
    const startedAt = Date.now();
    const args: ProviderChatArgs = {
      kimiConfig: modelConfig,
      messages: buildMessages(task, pack, agent) || [],
      tools: [],
      promptCacheKey: task.runId,
    };
    if (fetchImpl !== undefined) args.fetchImpl = fetchImpl;
    if (controls.signal) args.signal = controls.signal;
    const response = await modelCall(args);
    const summary = messageText(response).trim();
    if (!summary) {
      throw new Error(`Provider adapter returned empty output for ${task.taskId}`);
    }
    const inputChars = pack.entries.reduce((sum, entry) => sum + entry.text.length, 0) + task.instruction.length;
    const warnings = [
      ...(pack.redactionReport.redactedCount > 0 ? ['Input contained redacted secret-like text.'] : []),
      ...(pack.forbidden.length > 0 ? [`${pack.forbidden.length} context refs omitted by policy.`] : []),
      ...(response.stream_interrupted ? ['Provider stream was interrupted; output may be partial.'] : []),
    ];
    return {
      taskId: task.taskId,
      agentId: task.agentId,
      status: response.stream_interrupted ? 'partial' : 'succeeded',
      summary,
      structured: structuredResult(response, summary, pack),
      evidenceRefs: pack.entries.map((entry) => ({ refId: entry.refId, label: entry.label, uri: entry.uri })),
      artifactRefs: [],
      proposedOps: [],
      confidence: response.stream_interrupted ? 0.58 : 0.82,
      warnings,
      usage: usageFrom(response, inputChars, summary, Math.max(1, Date.now() - startedAt)),
      nextSuggestedTasks: [],
    };
  };
}