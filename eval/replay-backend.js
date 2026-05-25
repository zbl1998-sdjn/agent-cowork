import {
  createMemoryModelRecordStore,
  createModelReplayer,
} from '../apps/host/src/runtime/model-recorder.js';

export function defaultEvalModelInput({ task }) {
  return {
    messages: [{ role: 'user', content: task.prompt }],
    tools: [],
  };
}

function defaultMapResponseToResult({ response }) {
  if (response?.evalResult && typeof response.evalResult === 'object') return response.evalResult;
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
} = {}) {
  const store = createMemoryModelRecordStore(records);
  const replayModelCall = createModelReplayer({ store }).wrap();
  return async function offlineReplayExecutor(context) {
    const response = await replayModelCall(buildModelInput(context));
    return mapResponseToResult({ ...context, response });
  };
}
