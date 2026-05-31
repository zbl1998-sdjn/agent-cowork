// Agent 运行记录(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:把一次 Agent 流式运行收尾落成 run 记录(含配置快照、系统提示词版本)并写入运行索引。是 agent-stream 的辅助。
// 依赖:L2 run-store/runs-index + L1 system-prompt + 同层 agent-config-snapshot。导出:recordAgentRun。
// @ts-check
import { writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { SYSTEM_PROMPT_VERSION } from '../kimi/system-prompt.js';
import { buildAgentConfigSnapshot } from './agent-config-snapshot.js';

/**
 * @typedef {{ upsert(summary: unknown, context?: RequestContext): unknown }} RunsIndexLike
 * @typedef {{ tenantId?: unknown, userId?: unknown, traceId?: unknown, [key: string]: unknown }} RequestContext
 * @typedef {Record<string, unknown> & { model?: unknown, provider?: unknown }} ModelConfig
 * @typedef {{ text?: unknown, steps?: unknown, usage?: unknown }} AgentOutcome
 * @typedef {{ runStoreRoot: string, runsIndex: RunsIndexLike, requestContext: RequestContext, runId: string, kimiConfig: ModelConfig, body: unknown, trustedRoot: string, startedAt: Date, status: string, prompt: unknown, outcome: AgentOutcome, events: unknown[] }} RecordAgentRunOptions
 */

/** @param {unknown} kimiConfig */
function modelProvider(kimiConfig) {
  const config = kimiConfig && typeof kimiConfig === 'object' ? /** @type {ModelConfig} */ (kimiConfig) : {};
  return String(config.provider || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

/** @param {RecordAgentRunOptions} options */
export function recordAgentRun({
  runStoreRoot,
  runsIndex,
  requestContext,
  runId,
  kimiConfig,
  body,
  trustedRoot,
  startedAt,
  status,
  prompt,
  outcome,
  events,
}) {
  const finishedAt = new Date();
  const record = {
    id: runId,
    type: 'agent-chat',
    provider: modelProvider(kimiConfig),
    model: kimiConfig.model,
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    promptBuilder: 'agent-system-prompt',
    configSnapshot: buildAgentConfigSnapshot(body, kimiConfig),
    mode: 'agent',
    trustedRoot,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status,
    context: requestContext,
    input: { prompt: String(prompt || '') },
    result: { ok: status === 'succeeded', text: outcome.text, steps: outcome.steps, usage: outcome.usage },
    events,
  };
  try {
    const runPath = writeRunRecord(runStoreRoot, record);
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
  } catch {
    // Recording is diagnostic; never break the response on record/index failure.
  }
}
