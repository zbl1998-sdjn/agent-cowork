import { callProviderChatCompletion } from '../engine/provider/index.js';
import type { ModelConfig, ProviderChatArgs, ProviderChatResult } from '../engine/provider/index.js';
import { decideEgressPolicy, enforceRecordedEgressDecision } from '../security/egress-gateway.js';
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
type ProviderPromptMessage = {
  role: 'system' | 'user';
  content: string;
};

export type ProviderTaskRunnerOptions = {
  modelConfig: ModelConfig;
  modelCall?: ProviderModelCall | undefined;
  fetchImpl?: unknown;
  // 出站策略与审计根；缺失时在任何真实 provider 调用前 fail-closed。
  trustedRoot?: unknown;
};

function estimateTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4);
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
  const inputTokens = numberField(usage, ['prompt_tokens', 'input_tokens']) || estimateTokens(fallbackInputChars);
  const outputTokens = numberField(usage, ['completion_tokens', 'output_tokens']) || estimateTokens(output.length);
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

function messageContentCharacters(messages: readonly ProviderPromptMessage[]): number {
  return messages.reduce((sum, message) => sum + stringContent(message.content).length, 0);
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

function buildMessages(task: AgentTask, pack: ContextPack, agent: AgentDefinition): ProviderPromptMessage[] {
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
  trustedRoot,
}: ProviderTaskRunnerOptions) {
  return async function providerTaskRunner(
    task: AgentTask,
    pack: ContextPack,
    agent: AgentDefinition,
    controls: { signal?: AbortSignal | null | undefined } = {},
  ): Promise<AgentResult> {
    const startedAt = Date.now();
    const messages = buildMessages(task, pack, agent);
    const args: ProviderChatArgs = {
      kimiConfig: modelConfig,
      messages,
      tools: [],
      promptCacheKey: task.runId,
    };
    if (fetchImpl !== undefined) args.fetchImpl = fetchImpl;
    if (controls.signal) args.signal = controls.signal;
    const inputCharacters = messageContentCharacters(messages);
    // 与对话路径(model-resilience.ts)同一出站闸门:此前这里直接裸调模型,air_gap/
    // local_strict 下配了云端 provider 时,orchestrator 任务(Agent Team)会绕过安全模式
    // 实际出网。非 allow(含 needs_approval)就抛错——由调用方呈现,不静默继续。
    const egress = decideEgressPolicy({
      kind: 'model_inference',
      provider: modelConfig?.provider,
      model: modelConfig?.model,
      baseUrl: modelConfig?.baseUrl,
      securityMode: modelConfig?.securityMode,
      content: args.messages,
      trustedRoot,
    });
    enforceRecordedEgressDecision(trustedRoot, egress);
    const response = await modelCall(args);
    const summary = messageText(response).trim();
    if (!summary) {
      throw new Error(`Provider adapter returned empty output for ${task.taskId}`);
    }
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
      usage: usageFrom(response, inputCharacters, summary, Math.max(1, Date.now() - startedAt)),
      nextSuggestedTasks: [],
    };
  };
}
