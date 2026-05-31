import {
  createMemoryModelRecordStore,
  createModelReplayer,
} from '../apps/host/src/runtime/model-recorder.js';
import type { ModelRecord } from '../apps/host/src/runtime/model-recorder.js';
import type { EvalExecutorContext } from './runner.js';
import type { EvalTaskResult } from './scorers/index.js';

export type EvalModelInput = Record<string, unknown>;
export type EvalModelResponse = {
  evalResult?: EvalTaskResult;
  content?: unknown;
  message?: unknown;
  files?: unknown;
  toolCalls?: EvalTaskResult['toolCalls'];
  tool_calls?: EvalTaskResult['toolCalls'];
  approvals?: EvalTaskResult['approvals'];
  artifacts?: EvalTaskResult['artifacts'];
  branches?: EvalTaskResult['branches'];
  steps?: unknown;
  latencyMs?: unknown;
  usage?: unknown;
};
export type EvalModelInputBuilder = (context: EvalExecutorContext) => EvalModelInput;
export type EvalResponseMapper = (context: EvalExecutorContext & { response: EvalModelResponse }) => EvalTaskResult;
export type OfflineReplayExecutorOptions = {
  records?: ModelRecord[];
  buildModelInput?: EvalModelInputBuilder;
  mapResponseToResult?: EvalResponseMapper;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asModelResponse(value: unknown): EvalModelResponse {
  return isObject(value) ? value : {};
}

export function defaultEvalModelInput({ task }: EvalExecutorContext): EvalModelInput {
  return {
    messages: [{ role: 'user', content: task.prompt }],
    tools: [],
  };
}

function defaultMapResponseToResult({ response }: EvalExecutorContext & { response: EvalModelResponse }): EvalTaskResult {
  if (response.evalResult && isObject(response.evalResult)) return response.evalResult;
  return {
    response: response?.content || response?.message || '',
    files: response?.files || {},
    toolCalls: response?.toolCalls || response?.tool_calls || [],
    approvals: response?.approvals || [],
    artifacts: response?.artifacts || [],
    branches: response?.branches || [],
    steps: response?.steps || 1,
    latencyMs: response?.latencyMs || 0,
    usage: response?.usage || {},
  };
}

export function createOfflineReplayExecutor({
  records = [],
  buildModelInput = defaultEvalModelInput,
  mapResponseToResult = defaultMapResponseToResult,
}: OfflineReplayExecutorOptions = {}) {
  const store = createMemoryModelRecordStore(records);
  const replayModelCall = createModelReplayer({ store }).wrap();
  return async function offlineReplayExecutor(context: EvalExecutorContext): Promise<EvalTaskResult> {
    const response = asModelResponse(await replayModelCall(buildModelInput(context)));
    return mapResponseToResult({ ...context, response });
  };
}
