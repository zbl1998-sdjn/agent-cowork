// Agent 运行记录(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:把一次 Agent 流式运行落成 run 记录并写入运行索引——启动时先写 status=running 的
//       初始档案(让任务中心立即看到进行中任务、事件回放端点可订阅),收尾时用完整记录
//       (含配置快照、系统提示词版本、事件)覆盖。记录是诊断路径,失败不能打断主响应。
// 依赖:L2 run-store/runs-index + L1 system-prompt。
import { z } from 'zod';
import { writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { SYSTEM_PROMPT_VERSION } from '../engine/system-prompt.js';
import { buildAgentConfigSnapshot } from './agent-config-snapshot.js';
import { AtRestKeyError } from '../security/at-rest.js';
import { redactValue } from '../security/redaction.js';

export type RunsIndexLike = { upsert(summary: unknown, context?: RequestContext): unknown };
export type RequestContext = { tenantId?: unknown; userId?: unknown; traceId?: unknown; [key: string]: unknown };
export type ModelConfig = Record<string, unknown> & { model?: unknown; provider?: unknown };
export type AgentOutcome = { text?: unknown; steps?: unknown; usage?: unknown };
export type RecordAgentRunOptions = {
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  requestContext: RequestContext;
  runId: string;
  modelConfig: ModelConfig;
  body: unknown;
  trustedRoot: string;
  startedAt: Date;
  status: string;
  prompt: unknown;
  outcome: AgentOutcome;
  events: unknown[];
};

const requestContextSchema = z.object({
  tenantId: z.unknown().optional(),
  userId: z.unknown().optional(),
  traceId: z.unknown().optional(),
}).loose();

const modelConfigSchema = z.object({
  model: z.unknown().optional(),
  provider: z.unknown().optional(),
}).loose();

const outcomeSchema = z.object({
  text: z.unknown().optional(),
  steps: z.unknown().optional(),
  usage: z.unknown().optional(),
}).loose();

const recordOptionsSchema = z.object({
  runStoreRoot: z.string(),
  runsIndex: z.custom<RunsIndexLike>(
    (value) => value != null && typeof value === 'object' && typeof (value as { upsert?: unknown }).upsert === 'function',
    { message: 'runsIndex must expose upsert(summary, context)' },
  ),
  requestContext: requestContextSchema,
  runId: z.string().trim().min(1),
  modelConfig: modelConfigSchema,
  body: z.unknown(),
  trustedRoot: z.string(),
  startedAt: z.instanceof(Date),
  status: z.string().trim().min(1),
  prompt: z.unknown(),
  outcome: outcomeSchema,
  events: z.array(z.unknown()),
}).strict();

function parseRecordOptions(options: unknown): RecordAgentRunOptions | null {
  const result = recordOptionsSchema.safeParse(options);
  return result.success ? result.data : null;
}

function modelProvider(modelConfig: ModelConfig): string {
  return String(modelConfig.provider || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

function safeDiagnosticValue(value: unknown, fallback: unknown): unknown {
  try {
    return redactValue(value);
  } catch {
    return fallback;
  }
}

export type RecordAgentRunStartOptions = {
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  requestContext: RequestContext;
  runId: string;
  modelConfig: ModelConfig;
  trustedRoot: string;
  startedAt: Date;
  prompt: unknown;
};

/** 运行启动时写入 status=running 的初始档案;收尾的 recordAgentRun 会整体覆盖它。 */
export function recordAgentRunStart({
  runStoreRoot,
  runsIndex,
  requestContext,
  runId,
  modelConfig,
  trustedRoot,
  startedAt,
  prompt,
}: RecordAgentRunStartOptions): void {
  try {
    const record = {
      id: runId,
      type: 'agent-chat',
      provider: modelProvider(modelConfig),
      model: modelConfig.model,
      mode: 'agent',
      trustedRoot,
      startedAt: startedAt.toISOString(),
      status: 'running',
      context: requestContext,
      input: { prompt: String(prompt || '') },
      events: [],
    };
    const runPath = writeRunRecord(runStoreRoot, record);
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
  } catch (error) {
    if (error instanceof AtRestKeyError) throw error;
    // 初始档案仅用于任务中心可见性;写入失败不阻断对话流,收尾记录仍会照常落盘。
  }
}

export function recordAgentRun(options: unknown): void {
  const parsed = parseRecordOptions(options);
  if (!parsed) return;
  const {
    runStoreRoot,
    runsIndex,
    requestContext,
    runId,
    modelConfig,
    body,
    trustedRoot,
    startedAt,
    status,
    prompt,
    outcome,
    events,
  } = parsed;

  try {
    const finishedAt = new Date();
    const record = {
      id: runId,
      type: 'agent-chat',
      provider: modelProvider(modelConfig),
      model: modelConfig.model,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      promptBuilder: 'agent-system-prompt',
      configSnapshot: buildAgentConfigSnapshot(body, modelConfig),
      mode: 'agent',
      trustedRoot,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status,
      context: requestContext,
      input: { prompt: String(prompt || '') },
      result: {
        ok: status === 'succeeded',
        text: outcome.text,
        steps: safeDiagnosticValue(outcome.steps, [{ error: 'step diagnostics omitted after redaction failure' }]),
        usage: outcome.usage,
      },
      events: safeDiagnosticValue(events, [{ type: 'redaction_failed' }]),
    };
    const runPath = writeRunRecord(runStoreRoot, record);
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
  } catch (error) {
    if (error instanceof AtRestKeyError) throw error;
    // 记录仅用于诊断;run 记录或索引失败不能打断主响应。
  }
}
